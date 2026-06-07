// Koa middleware that auto-captures request telemetry and enqueues it to a
// BeaconClient. It wraps `await next()` and records on completion (in a finally
// block), so the event is enqueued off the response path and never delays it.
//
// Route templating: Koa core has no router, so the low-cardinality route
// template depends on @koa/router (or koa-router), which sets `ctx._matchedRoute`
// to the matched path pattern (e.g. "/users/:id"). When no router is present (or
// no route matched), the middleware falls back to the concrete request path —
// see the README note on this limitation.
//
// Usage:
//   import Koa from 'koa';
//   import Router from '@koa/router';
//   import { BeaconClient, beaconKoa } from 'beaconhq';
//   const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });
//   const app = new Koa();
//   app.use(beaconKoa(beacon));          // register before the router
//   const router = new Router();
//   router.get('/users/:id', (ctx) => { ctx.body = ctx.params.id; });
//   app.use(router.routes());
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

// Minimal structural types so we don't hard-depend on koa at build time.
interface KoaRequestLike {
  method: string;
  path: string;
  get(field: string): string;
  header?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  // koa-bodyparser / @koa/bodyparser populate ctx.request.body when configured.
  body?: unknown;
}
interface KoaResponseLike {
  header?: Record<string, string | string[] | number | undefined>;
  headers?: Record<string, string | string[] | number | undefined>;
}
interface KoaContextLike {
  method: string;
  path: string;
  status: number;
  request: KoaRequestLike;
  response?: KoaResponseLike;
  // The response body the app set (string/object/Buffer/stream).
  body?: unknown;
  // Set by @koa/router / koa-router to the matched route template.
  _matchedRoute?: string | RegExp;
  // koa-router also exposes the route layer here on some versions.
  matched?: Array<{ path?: string }>;
  get(field: string): string;
}
type KoaNext = () => Promise<void>;

export interface BeaconKoaOptions extends CaptureOptions {
  /** Header to read the consumer/identity from (e.g. an API key id). */
  consumerHeader?: string;
}

// Assemble a masked BeaconCapture for a Koa request. Request body comes from
// ctx.request.body (populated by a body parser, already in memory — we never read
// the raw stream). Response body comes from ctx.body when it's a string/object
// (a stream/Buffer binary response is skipped). Never throws.
function buildKoaCapture(ctx: KoaContextLike, cfg: CaptureConfig): BeaconCapture | null {
  const out: BeaconCapture = {};
  let any = false;
  try {
    if (cfg.captureHeaders) {
      const reqHeaders = ctx.request.headers ?? ctx.request.header;
      if (reqHeaders) {
        out.request_headers = maskHeaders(reqHeaders, cfg);
        any = true;
      }
      const resHeaders = ctx.response?.headers ?? ctx.response?.header;
      if (resHeaders) {
        out.response_headers = maskHeaders(resHeaders, cfg);
        any = true;
      }
    }
    if (cfg.captureRequestBody && ctx.request.body != null && ctx.request.body !== '') {
      const ct = ctx.request.get?.('content-type') ?? undefined;
      const masked = maskBody(ctx.request.body, ct, cfg, 'request');
      if (masked) {
        out.request_body = masked.body;
        out.request_body_truncated = masked.truncated;
        out.request_content_type = masked.contentType;
        any = true;
      }
    }
    if (cfg.captureResponseBody && ctx.body != null) {
      const ct = ctx.get?.('content-type') || (typeof ctx.body === 'object' ? 'application/json' : 'text/plain');
      // Only string/object bodies are safely capturable; skip streams/Buffers.
      const isStream = typeof (ctx.body as { pipe?: unknown }).pipe === 'function';
      const isBuffer = typeof (ctx.body as { byteLength?: number }).byteLength === 'number' && typeof ctx.body !== 'string';
      if (!isStream && !isBuffer && isCapturableContentType(ct)) {
        const masked = maskBody(ctx.body, ct, cfg, 'response');
        if (masked) {
          out.response_body = masked.body;
          out.response_body_truncated = masked.truncated;
          out.response_content_type = masked.contentType;
          any = true;
        }
      }
    }
  } catch {
    return any ? out : null;
  }
  return any ? out : null;
}

function routeTemplate(ctx: KoaContextLike): string {
  // @koa/router sets ctx._matchedRoute to the registered path string.
  const matched = ctx._matchedRoute;
  if (typeof matched === 'string' && matched.length > 0) return matched;
  // No router / unmatched: fall back to the concrete path (higher cardinality).
  return ctx.path;
}

export function beaconKoa(client: BeaconClient, options: BeaconKoaOptions = {}) {
  const cfg = resolveCaptureConfig(options);
  return async (ctx: KoaContextLike, next: KoaNext): Promise<void> => {
    const start = performance.now();
    let error: string | null = null;
    try {
      await next();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err; // don't swallow the host app's error
    } finally {
      try {
        const duration = Math.round(performance.now() - start);
        // On a thrown error Koa hasn't yet written the status; report 500.
        const status = error ? 500 : ctx.status;
        let consumer: string | null = null;
        if (options.consumerHeader) {
          const getter = ctx.get ?? ctx.request?.get?.bind(ctx.request);
          const v = getter ? getter.call(ctx, options.consumerHeader) : '';
          consumer = v ? v : null;
        }
        const capture = captureDisabled(cfg) ? null : buildKoaCapture(ctx, cfg);
        client.capture({
          ts: new Date().toISOString(),
          method: ctx.method ?? ctx.request.method,
          route: routeTemplate(ctx),
          path: ctx.path ?? ctx.request.path,
          status,
          duration_ms: duration,
          consumer,
          error: error ?? (status >= 500 ? `HTTP ${status}` : null),
          capture,
        });
      } catch {
        // Telemetry must never break the request path.
      }
    }
  };
}
