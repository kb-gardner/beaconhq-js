// Express middleware that auto-captures request telemetry and enqueues it to a
// BeaconClient. Best-effort route templating: uses the matched route pattern
// (req.route.path mounted under req.baseUrl) when available, else the URL path.
//
// Usage:
//   import express from 'express';
//   import { BeaconClient, beaconExpress } from 'beaconhq';
//   const beacon = new BeaconClient({ apiKey });
//   const app = express();
//   app.use(express.json());                 // (if you want request-body capture)
//   app.use(beaconExpress(beacon, { captureHeaders: true, captureRequestBody: true }));
//
// OPT-IN request inspection (OFF by default): pass capture flags to record masked,
// truncated request/response headers + bodies. Request bodies are read ONLY from
// the already-parsed `req.body` (set by express.json()/urlencoded()) — we never
// touch the raw request stream, so the host's own body handling (including a
// Stripe raw-body webhook route) is completely undisturbed. Response bodies are
// captured by buffering what the app writes to res, bounded by maxBodyBytes.
import type { BeaconClient, BeaconCapture } from './client.js';
import {
  resolveCaptureConfig,
  captureDisabled,
  maskHeaders,
  maskBody,
  isCapturableContentType,
  type CaptureConfig,
  type CaptureOptions,
} from './capture.js';

// Structural types so we don't hard-depend on express at build time.
interface ExpressReqLike {
  method: string;
  originalUrl?: string;
  url: string;
  baseUrl?: string;
  path?: string;
  route?: { path?: string };
  body?: unknown;
  get?(name: string): string | undefined;
  headers?: Record<string, string | string[] | undefined>;
}
interface ExpressResLike {
  statusCode: number;
  getHeader?(name: string): string | string[] | number | undefined;
  getHeaders?(): Record<string, string | string[] | number | undefined>;
  write?: (...args: unknown[]) => boolean;
  end?: (...args: unknown[]) => unknown;
  on(event: 'finish' | 'close', cb: () => void): void;
}
type ExpressNext = (err?: unknown) => void;

export interface BeaconExpressOptions extends CaptureOptions {
  consumerHeader?: string;
}

function routeTemplate(req: ExpressReqLike): string {
  // req.route is only populated after routing; combine with baseUrl for routers.
  if (req.route?.path) {
    const base = req.baseUrl ?? '';
    return (base + req.route.path) || '/';
  }
  // No route matched (404 / middleware-only). Fall back to the concrete FULL path,
  // including the router mount prefix. Under `app.use('/api', router)`, req.path is
  // relative to the mount and drops req.baseUrl, so an unmatched `/api/nope` would
  // be mislabeled `/nope` — use baseUrl + path (or originalUrl) to keep the prefix.
  if (req.path != null) {
    const base = req.baseUrl ?? '';
    return (base + req.path) || '/';
  }
  return (req.originalUrl ?? req.url).split('?')[0] ?? req.url;
}

// Buffer what the app writes to the response, bounded so capture can't grow
// memory without limit. Wraps res.write/res.end and ALWAYS forwards to the
// originals, so the response to the client is byte-for-byte unchanged. Returns a
// getter for the captured text; fail-open (any error leaves the response intact).
function tapResponseBody(
  res: ExpressResLike,
  cfg: CaptureConfig,
): () => { text: string; truncated: boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const cap = cfg.maxBodyBytes;

  const collect = (chunk: unknown, encoding?: unknown): void => {
    try {
      if (chunk == null || size >= cap) {
        if (chunk != null && size >= cap) truncated = true;
        return;
      }
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding)
          : null;
      if (!buf) return;
      const remaining = cap - size;
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        size = cap;
        truncated = true;
      } else {
        chunks.push(buf);
        size += buf.length;
      }
    } catch {
      /* never break the response */
    }
  };

  const origWrite = res.write?.bind(res);
  const origEnd = res.end?.bind(res);
  if (origWrite) {
    res.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      collect(chunk, rest[0]);
      return origWrite(chunk, ...rest);
    } as ExpressResLike['write'];
  }
  if (origEnd) {
    res.end = function (this: unknown, chunk?: unknown, ...rest: unknown[]): unknown {
      // res.end(callback) — first arg is a function, not a body chunk.
      if (typeof chunk !== 'function') collect(chunk, rest[0]);
      return origEnd(chunk, ...rest);
    } as ExpressResLike['end'];
  }

  return () => ({
    text: Buffer.concat(chunks).toString('utf8'),
    truncated,
  });
}

export function beaconExpress(
  client: BeaconClient,
  options: BeaconExpressOptions = {},
) {
  const cfg = resolveCaptureConfig(options);
  const wantResponseBody = cfg.captureResponseBody;

  return (req: ExpressReqLike, res: ExpressResLike, next: ExpressNext): void => {
    const start = performance.now();
    let finished = false;

    // Snapshot request headers + body BEFORE the handler runs (the body is the
    // already-parsed req.body; we never read the stream). Cheap + safe; held in
    // closure so the finish handler can mask + attach them.
    let reqHeadersSnapshot: ExpressReqLike['headers'];
    let reqBodySnapshot: unknown;
    let reqContentType: string | undefined;
    let getResponseBody: (() => { text: string; truncated: boolean }) | null = null;

    if (!captureDisabled(cfg)) {
      try {
        if (cfg.captureHeaders) reqHeadersSnapshot = req.headers;
        if (cfg.captureRequestBody) {
          reqContentType = req.get?.('content-type') ?? undefined;
          reqBodySnapshot = req.body;
        }
        if (wantResponseBody) getResponseBody = tapResponseBody(res, cfg);
      } catch {
        /* capture setup must never break the request */
      }
    }

    const record = () => {
      if (finished) return;
      finished = true;
      try {
        const duration = Math.round(performance.now() - start);
        const rawPath = (req.originalUrl ?? req.url).split('?')[0] ?? req.url;
        let consumer: string | null = null;
        if (options.consumerHeader) {
          const v = req.get
            ? req.get(options.consumerHeader)
            : (req.headers?.[options.consumerHeader.toLowerCase()] as
                | string
                | undefined);
          consumer = v ?? null;
        }

        let capture: BeaconCapture | null = null;
        if (!captureDisabled(cfg)) {
          try {
            capture = buildCapture(cfg, {
              reqHeaders: reqHeadersSnapshot,
              reqBody: reqBodySnapshot,
              reqContentType,
              resHeaders: res.getHeaders?.(),
              resContentType: (() => {
                const ct = res.getHeader?.('content-type');
                return typeof ct === 'string' ? ct : Array.isArray(ct) ? ct[0] : undefined;
              })(),
              getResponseBody,
            });
          } catch {
            capture = null;
          }
        }

        client.capture({
          ts: new Date().toISOString(),
          method: req.method,
          route: routeTemplate(req),
          path: rawPath,
          status: res.statusCode,
          duration_ms: duration,
          consumer,
          error: res.statusCode >= 500 ? `HTTP ${res.statusCode}` : null,
          capture,
        });
      } catch {
        // Telemetry must never break the request path.
      }
    };

    res.on('finish', record);
    res.on('close', record);
    next();
  };
}

// Assemble a BeaconCapture from the raw snapshots, applying masking + bounding.
// Shared shape used by the express + nest(express) adapters. Returns null when
// nothing capturable was produced. Never throws.
export function buildCapture(
  cfg: CaptureConfig,
  parts: {
    reqHeaders?: Record<string, string | string[] | undefined>;
    reqBody?: unknown;
    reqContentType?: string;
    resHeaders?: Record<string, string | string[] | number | undefined>;
    resContentType?: string;
    getResponseBody?: (() => { text: string; truncated: boolean }) | null;
  },
): BeaconCapture | null {
  const out: BeaconCapture = {};
  let any = false;

  if (cfg.captureHeaders) {
    if (parts.reqHeaders) {
      out.request_headers = maskHeaders(parts.reqHeaders, cfg);
      any = true;
    }
    if (parts.resHeaders) {
      out.response_headers = maskHeaders(parts.resHeaders, cfg);
      any = true;
    }
  }

  if (cfg.captureRequestBody && parts.reqBody !== undefined && parts.reqBody !== null) {
    const masked = maskBody(parts.reqBody, parts.reqContentType, cfg, 'request');
    if (masked) {
      out.request_body = masked.body;
      out.request_body_truncated = masked.truncated;
      out.request_content_type = masked.contentType;
      any = true;
    }
  }

  if (cfg.captureResponseBody && parts.getResponseBody) {
    const captured = parts.getResponseBody();
    if (captured.text && isCapturableContentType(parts.resContentType)) {
      const masked = maskBody(captured.text, parts.resContentType, cfg, 'response');
      if (masked) {
        out.response_body = masked.body;
        out.response_body_truncated = masked.truncated || captured.truncated;
        out.response_content_type = masked.contentType;
        any = true;
      }
    }
  }

  return any ? out : null;
}
