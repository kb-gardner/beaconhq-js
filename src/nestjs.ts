// NestJS interceptor that auto-captures request telemetry and enqueues it to a
// BeaconClient. Works with both of Nest's HTTP platforms (Express and Fastify)
// by reading the underlying request from the execution context.
//
// Usage (global interceptor):
//   import { BeaconClient, BeaconInterceptor } from 'beaconhq';
//   const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });
//
//   const app = await NestFactory.create(AppModule);
//   app.useGlobalInterceptors(new BeaconInterceptor(beacon));
//   await app.listen(3000);
//
// Or per-controller/handler via @UseInterceptors(new BeaconInterceptor(beacon)).
//
// The interceptor records on response completion (RxJS finalize/tap), so capture
// never blocks the handler. It never throws into the request path: the recording
// is wrapped so a telemetry failure can't break or delay the host app, and the
// handler's own stream (including errors) is passed through untouched.
import type { BeaconClient, BeaconValidationError, BeaconCapture } from './client.js';
import { fromNestException } from './validation.js';
import {
  resolveCaptureConfig,
  captureDisabled,
  maskHeaders,
  maskBody,
  type CaptureConfig,
  type CaptureOptions,
} from './capture.js';

// ---- Minimal structural types (no hard dep on @nestjs/common or rxjs) --------

interface HttpRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  path?: string;
  // Express: matched route; Fastify-under-Nest: routeOptions.url / routerPath.
  route?: { path?: string };
  routeOptions?: { url?: string };
  routerPath?: string;
  headers?: Record<string, string | string[] | undefined>;
  // Parsed request body (Nest body parser populates this on both platforms).
  body?: unknown;
}
interface HttpResponseLike {
  statusCode?: number;
}
interface HttpArgumentsHostLike {
  getRequest<T = HttpRequestLike>(): T;
  getResponse<T = HttpResponseLike>(): T;
}
interface ExecutionContextLike {
  switchToHttp(): HttpArgumentsHostLike;
}
interface CallHandlerLike<T = unknown> {
  handle(): RxObservableLike<T>;
}

// A tiny structural slice of an RxJS Observable: enough to subscribe and to
// return something Nest will accept. We don't import rxjs; we operate on the
// Observable the handler returns and wrap it with our own subscribe-through.
interface RxSubscriberLike<T> {
  next?: (value: T) => void;
  error?: (err: unknown) => void;
  complete?: () => void;
}
interface RxSubscriptionLike {
  unsubscribe(): void;
}
interface RxObservableLike<T> {
  subscribe(observer: RxSubscriberLike<T>): RxSubscriptionLike;
}

export interface BeaconNestOptions extends CaptureOptions {
  /** Header to read the consumer/identity from (e.g. an API key id). */
  consumerHeader?: string;
}

// Assemble a masked BeaconCapture for a Nest request. Captures request headers
// and the already-parsed request body (no raw-stream access). NOTE: response-body
// capture is NOT supported by the Nest interceptor (the handler's RxJS stream is
// forwarded untouched, and buffering it would risk altering streamed responses) —
// captureResponseBody is accepted but ignored here; use the express/fastify
// adapter directly for response bodies. Never throws.
function buildNestCapture(req: HttpRequestLike, cfg: CaptureConfig): BeaconCapture | null {
  const out: BeaconCapture = {};
  let any = false;
  try {
    if (cfg.captureHeaders && req.headers) {
      out.request_headers = maskHeaders(req.headers, cfg);
      any = true;
    }
    if (cfg.captureRequestBody && req.body != null && req.body !== '') {
      const ctHeader = req.headers?.['content-type'];
      const ct = Array.isArray(ctHeader) ? ctHeader[0] : ctHeader;
      const masked = maskBody(req.body, ct, cfg, 'request');
      if (masked) {
        out.request_body = masked.body;
        out.request_body_truncated = masked.truncated;
        out.request_content_type = masked.contentType;
        any = true;
      }
    }
  } catch {
    return any ? out : null;
  }
  return any ? out : null;
}

function routeTemplate(req: HttpRequestLike): string {
  // Express platform: req.route.path (+ baseUrl for mounted routers).
  if (req.route?.path) {
    const base = req.baseUrl ?? '';
    return base + req.route.path || '/';
  }
  // Fastify platform under Nest.
  const fastifyTmpl = req.routeOptions?.url ?? req.routerPath;
  if (fastifyTmpl) return fastifyTmpl;
  // Fallback: concrete path.
  const raw = req.originalUrl ?? req.url ?? req.path ?? '';
  return raw.split('?')[0] || '/';
}

function readConsumer(
  req: HttpRequestLike,
  header: string | undefined,
): string | null {
  if (!header) return null;
  const v = req.headers?.[header.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Nest interceptor. Construct with a BeaconClient and (optionally) a
 * consumerHeader, then register globally or per-handler.
 *
 * Implements Nest's `NestInterceptor` shape structurally — no compile-time
 * dependency on `@nestjs/common`. It captures method/route/status/duration/
 * consumer when the response stream completes or errors.
 */
export class BeaconInterceptor {
  private readonly client: BeaconClient;
  private readonly options: BeaconNestOptions;
  private readonly captureCfg: CaptureConfig;

  constructor(client: BeaconClient, options: BeaconNestOptions = {}) {
    this.client = client;
    this.options = options;
    this.captureCfg = resolveCaptureConfig(options);
  }

  intercept(
    context: ExecutionContextLike,
    next: CallHandlerLike,
  ): RxObservableLike<unknown> {
    const start = performance.now();
    let recorded = false;

    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequestLike>();
    const res = http.getResponse<HttpResponseLike>();

    const record = (errored: boolean, err?: unknown): void => {
      if (recorded) return;
      recorded = true;
      try {
        const duration = Math.round(performance.now() - start);
        let status = res.statusCode ?? 200;
        if (errored) {
          // Nest HttpException carries a getStatus(); default to 500 otherwise.
          const maybe = err as { getStatus?: () => number; status?: number };
          const s =
            typeof maybe?.getStatus === 'function'
              ? maybe.getStatus()
              : maybe?.status;
          if (typeof s === 'number') status = s;
          else if (!res.statusCode || res.statusCode < 400) status = 500;
        }
        const rawPath = (req.originalUrl ?? req.url ?? req.path ?? '').split(
          '?',
        )[0];
        // class-validator: the default ValidationPipe throws a 400
        // BadRequestException carrying the constraint messages — extract them.
        let validationErrors: BeaconValidationError[] | undefined;
        if (errored && err) {
          try {
            validationErrors = fromNestException(err);
          } catch {
            /* best-effort; never throw */
          }
        }
        const capture = captureDisabled(this.captureCfg)
          ? null
          : buildNestCapture(req, this.captureCfg);
        this.client.capture({
          ts: new Date().toISOString(),
          method: req.method ?? 'GET',
          route: routeTemplate(req),
          path: rawPath || '/',
          status,
          duration_ms: duration,
          consumer: readConsumer(req, this.options.consumerHeader),
          error:
            errored && err
              ? err instanceof Error
                ? err.message
                : String(err)
              : status >= 500
                ? `HTTP ${status}`
                : null,
          validation_errors: validationErrors ?? null,
          capture,
        });
      } catch {
        // Telemetry must never break the request path.
      }
    };

    const source = next.handle();

    // Return a pass-through Observable: forward all values/errors/completion to
    // the real subscriber (so Nest behaves exactly as without us) and record on
    // terminal events. We avoid importing rxjs operators by re-wrapping subscribe.
    return {
      subscribe: (observer: RxSubscriberLike<unknown>): RxSubscriptionLike => {
        return source.subscribe({
          next: (value: unknown) => observer.next?.(value),
          error: (e: unknown) => {
            record(true, e);
            observer.error?.(e);
          },
          complete: () => {
            record(false);
            observer.complete?.();
          },
        });
      },
    };
  }
}

/**
 * Convenience factory mirroring the function-style adapters (beaconExpress,
 * beaconHono): returns a ready-to-register interceptor instance.
 */
export function beaconNest(
  client: BeaconClient,
  options: BeaconNestOptions = {},
): BeaconInterceptor {
  return new BeaconInterceptor(client, options);
}
