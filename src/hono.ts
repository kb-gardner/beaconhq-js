// Hono middleware that auto-captures request telemetry and enqueues it to a
// BeaconClient. Best-effort route templating: prefers Hono's matched route
// pattern (c.req.routePath) and falls back to the concrete path.
//
// Usage:
//   import { Hono } from 'hono';
//   import { BeaconClient, beaconHono } from 'beaconhq';
//   const beacon = new BeaconClient({ apiKey });
//   const app = new Hono();
//   app.use('*', beaconHono(beacon, { captureHeaders: true, captureResponseBody: true }));
//
// OPT-IN request inspection (OFF by default): pass capture flags to record masked,
// truncated headers + bodies. Bodies are read via CLONES of the Web Request/
// Response so the host handler's own body consumption is never disturbed (Hono's
// underlying Request body is a stream — we clone before reading). Only text/JSON
// content types are captured; binary/streaming is skipped.
import type { BeaconClient, BeaconValidationError, BeaconCapture } from './client.js';
import { fromZodError, fromZodResult } from './validation.js';
import {
  resolveCaptureConfig,
  captureDisabled,
  maskHeaders,
  maskBody,
  isCapturableContentType,
  type CaptureConfig,
  type CaptureOptions,
} from './capture.js';

// Minimal structural types so we don't hard-depend on hono at build time.
interface HonoReqLike {
  method: string;
  path: string;
  routePath?: string;
  header(name: string): string | undefined;
  // The underlying Web Request (Hono exposes it as c.req.raw). Optional/guarded.
  raw?: Request;
}
interface HonoContextLike {
  req: HonoReqLike;
  res: Response;
  get?(key: string): unknown;
}
type HonoNext = () => Promise<void>;

export interface BeaconHonoOptions extends CaptureOptions {
  /** Header to read the consumer/identity from (e.g. an API key id). */
  consumerHeader?: string;
  /**
   * Context key under which a captured validation error (a ZodError, or a
   * `{ success:false, error }` zValidator result) is stashed by the app. When set
   * and present, the middleware extracts structured validation_errors from it.
   * Defaults to `'beaconValidationError'`.
   */
  validationContextKey?: string;
}

// Read + mask a Web Request/Response body from a CLONE so the original stream the
// host handler reads is untouched. Returns null when not capturable. Never throws.
async function captureWebBody(
  source: { headers: Headers; clone?: () => unknown; text?: () => Promise<string> } | undefined,
  cfg: CaptureConfig,
  kind: 'request' | 'response',
): Promise<{ body: string; truncated: boolean; contentType: string | null } | null> {
  try {
    if (!source) return null;
    const contentType = source.headers.get('content-type');
    if (!isCapturableContentType(contentType)) return null;
    // Clone so reading the body never consumes the original the host uses.
    const clone =
      typeof source.clone === 'function' ? (source.clone() as { text(): Promise<string> }) : null;
    if (!clone || typeof clone.text !== 'function') return null;
    const raw = await clone.text();
    return maskBody(raw, contentType, cfg, kind);
  } catch {
    return null;
  }
}

export function beaconHono(client: BeaconClient, options: BeaconHonoOptions = {}) {
  const validationKey = options.validationContextKey ?? 'beaconValidationError';
  const cfg = resolveCaptureConfig(options);
  return async (c: HonoContextLike, next: HonoNext): Promise<void> => {
    const start = performance.now();
    let error: string | null = null;
    // Captured best-effort from a thrown Zod error (the typical Hono+Zod path:
    // `schema.parse()` in a handler, or a zValidator hook that rethrows).
    let validationErrors: BeaconValidationError[] | undefined;

    // Snapshot a request-body clone BEFORE next() so we read it independently of
    // the handler. Cheap: clone() just tees the stream; reading is deferred.
    let reqBodyClone: Request | undefined;
    if (!captureDisabled(cfg) && cfg.captureRequestBody) {
      try {
        reqBodyClone = c.req.raw?.clone();
      } catch {
        reqBodyClone = undefined;
      }
    }

    try {
      await next();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      validationErrors = fromZodError(err);
      throw err; // don't swallow the host app's error
    } finally {
      try {
        const duration = Math.round(performance.now() - start);
        const consumer = options.consumerHeader
          ? (c.req.header(options.consumerHeader) ?? null)
          : null;
        if (!validationErrors && typeof c.get === 'function') {
          try {
            const stashed = c.get(validationKey);
            if (stashed) validationErrors = fromZodResult(stashed);
          } catch {
            /* ignore */
          }
        }

        let capture: BeaconCapture | null = null;
        if (!captureDisabled(cfg)) {
          capture = await buildHonoCapture(c, cfg, reqBodyClone);
        }

        client.capture({
          ts: new Date().toISOString(),
          method: c.req.method,
          route: c.req.routePath ?? c.req.path,
          path: c.req.path,
          status: error ? 500 : c.res.status,
          duration_ms: duration,
          consumer,
          error,
          validation_errors: validationErrors ?? null,
          capture,
        });
      } catch {
        // Telemetry must never break the request path.
      }
    }
  };
}

async function buildHonoCapture(
  c: HonoContextLike,
  cfg: CaptureConfig,
  reqBodyClone: Request | undefined,
): Promise<BeaconCapture | null> {
  const out: BeaconCapture = {};
  let any = false;
  try {
    if (cfg.captureHeaders) {
      if (c.req.raw?.headers) {
        out.request_headers = maskHeaders(c.req.raw.headers, cfg);
        any = true;
      }
      if (c.res?.headers) {
        out.response_headers = maskHeaders(c.res.headers, cfg);
        any = true;
      }
    }
    if (cfg.captureRequestBody && reqBodyClone) {
      const masked = await captureWebBody(reqBodyClone, cfg, 'request');
      if (masked) {
        out.request_body = masked.body;
        out.request_body_truncated = masked.truncated;
        out.request_content_type = masked.contentType;
        any = true;
      }
    }
    if (cfg.captureResponseBody && c.res) {
      const masked = await captureWebBody(c.res, cfg, 'response');
      if (masked) {
        out.response_body = masked.body;
        out.response_body_truncated = masked.truncated;
        out.response_content_type = masked.contentType;
        any = true;
      }
    }
  } catch {
    return any ? out : null;
  }
  return any ? out : null;
}
