// Fastify plugin that auto-captures request telemetry and enqueues it to a
// BeaconClient. Best-effort route templating: prefers Fastify's matched route
// pattern (request.routeOptions.url, falling back to the legacy routerPath) and
// falls back to the concrete URL path.
//
// Usage:
//   import Fastify from 'fastify';
//   import { BeaconClient, fastifyBeacon } from 'beaconhq';
//   const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });
//   const app = Fastify();
//   await app.register(fastifyBeacon, { client: beacon });
//
// Registered as a plugin, it hooks `onResponse` so the event is recorded after
// the response is sent — off the request path. Telemetry never throws into the
// host app and never delays the response.
import type { BeaconClient, BeaconValidationError, BeaconCapture } from './client.js';
import { fromFastifyError } from './validation.js';
import {
  resolveCaptureConfig,
  captureDisabled,
  maskHeaders,
  maskBody,
  type CaptureConfig,
  type CaptureOptions,
} from './capture.js';

// A private symbol we stash the captured validation errors under, on the request,
// in the onError hook so the onResponse hook can read them. Symbol-keyed so it
// never collides with app/user request decorations.
const VALIDATION_SLOT = Symbol.for('beacon.fastify.validationErrors');
// Stash the masked response body (from onSend) on the request for onResponse.
const RESPONSE_BODY_SLOT = Symbol.for('beacon.fastify.responseBody');

// Minimal structural types so we don't hard-depend on fastify at build time.
interface FastifyRequestLike {
  method: string;
  url: string;
  // Fastify >=4 exposes the matched route template here.
  routeOptions?: { url?: string };
  // Legacy (Fastify <4) matched-route accessor.
  routerPath?: string;
  headers?: Record<string, string | string[] | undefined>;
  // Parsed request body (Fastify parses JSON/urlencoded into request.body).
  body?: unknown;
  // Our own stashes (set in onError/onSend, read in onResponse).
  [VALIDATION_SLOT]?: BeaconValidationError[];
  [RESPONSE_BODY_SLOT]?: { body: string; truncated: boolean; contentType: string | null };
}
interface FastifyReplyLike {
  statusCode: number;
  /** Fastify-tracked ms elapsed since the request was received. */
  elapsedTime?: number;
  getHeader?(name: string): string | string[] | number | undefined;
  getHeaders?(): Record<string, string | string[] | number | undefined>;
}
interface FastifyInstanceLike {
  addHook(
    name: 'onResponse',
    hook: (
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
    ) => void | Promise<void>,
  ): void;
  addHook(
    name: 'onError',
    hook: (
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
      error: unknown,
      done: () => void,
    ) => void,
  ): void;
  addHook(
    name: 'onSend',
    hook: (
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
      payload: unknown,
      done: (err?: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
}
type FastifyDone = (err?: Error) => void;

export interface BeaconFastifyOptions extends CaptureOptions {
  /** The BeaconClient to enqueue events into (required). */
  client: BeaconClient;
  /** Header to read the consumer/identity from (e.g. an API key id). */
  consumerHeader?: string;
}

function routeTemplate(req: FastifyRequestLike): string {
  // routeOptions.url is the registered template, e.g. "/users/:id".
  const tmpl = req.routeOptions?.url ?? req.routerPath;
  if (tmpl) return tmpl;
  // No route matched (404) or template unavailable: fall back to concrete path.
  return req.url.split('?')[0] ?? req.url;
}

function readConsumer(
  req: FastifyRequestLike,
  header: string | undefined,
): string | null {
  if (!header) return null;
  const v = req.headers?.[header.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// Assemble a masked BeaconCapture for a Fastify request. Request body is the
// already-parsed request.body (Fastify never exposes the raw stream here, so the
// host body handling is undisturbed). Response body was stashed by the onSend hook.
function buildFastifyCapture(
  request: FastifyRequestLike,
  reply: FastifyReplyLike,
  cfg: CaptureConfig,
): BeaconCapture | null {
  const out: BeaconCapture = {};
  let any = false;
  try {
    if (cfg.captureHeaders) {
      if (request.headers) {
        out.request_headers = maskHeaders(request.headers, cfg);
        any = true;
      }
      const resHeaders = reply.getHeaders?.();
      if (resHeaders) {
        out.response_headers = maskHeaders(resHeaders, cfg);
        any = true;
      }
    }
    if (cfg.captureRequestBody && request.body != null && request.body !== '') {
      const ctHeader = request.headers?.['content-type'];
      const ct = Array.isArray(ctHeader) ? ctHeader[0] : ctHeader;
      const masked = maskBody(request.body, ct, cfg, 'request');
      if (masked) {
        out.request_body = masked.body;
        out.request_body_truncated = masked.truncated;
        out.request_content_type = masked.contentType;
        any = true;
      }
    }
    const stashed = request[RESPONSE_BODY_SLOT];
    if (cfg.captureResponseBody && stashed) {
      out.response_body = stashed.body;
      out.response_body_truncated = stashed.truncated;
      out.response_content_type = stashed.contentType;
      any = true;
    }
  } catch {
    return any ? out : null;
  }
  return any ? out : null;
}

/**
 * Fastify plugin. Register with `app.register(fastifyBeacon, { client })`.
 *
 * It registers an `onResponse` hook that records one event per request after the
 * response has been sent, so capture never sits on the request path. Exposes a
 * `[Symbol.for('skip-override')]` marker so the hook is global (applies to all
 * routes), matching how observability plugins are normally registered.
 */
export function fastifyBeacon(
  instance: FastifyInstanceLike,
  opts: BeaconFastifyOptions,
  done: FastifyDone,
): void {
  const client = opts?.client;
  if (!client) {
    done(new Error('fastifyBeacon: `client` option is required'));
    return;
  }

  const cfg = resolveCaptureConfig(opts);

  // Response-body capture: onSend sees the serialized payload before it's sent.
  // We mask + bound it and stash it for onResponse; we ALWAYS forward the original
  // payload unchanged via done(null, payload) so the response is undisturbed.
  if (cfg.captureResponseBody) {
    instance.addHook('onSend', (request, reply, payload, doneHook) => {
      try {
        const ctHeader = reply.getHeader?.('content-type');
        const ct = typeof ctHeader === 'string' ? ctHeader : Array.isArray(ctHeader) ? ctHeader[0] : undefined;
        // Only string payloads are safely capturable here (Fastify serializes
        // JSON to a string by this hook); skip streams/Buffers.
        if (typeof payload === 'string') {
          const masked = maskBody(payload, ct, cfg, 'response');
          if (masked) request[RESPONSE_BODY_SLOT] = masked;
        }
      } catch {
        /* never break the response */
      }
      doneHook(null, payload);
    });
  }

  // Schema-validation failures surface as an error with an AJV `.validation`
  // array, which the onResponse hook doesn't get. Stash the extracted structured
  // errors on the request in onError so onResponse can attach them. Fail-open.
  instance.addHook('onError', (request, _reply, error, doneHook) => {
    try {
      const extracted = fromFastifyError(error);
      if (extracted) request[VALIDATION_SLOT] = extracted;
    } catch {
      // never break the host error path
    }
    doneHook();
  });

  instance.addHook('onResponse', (request, reply) => {
    try {
      // Fastify tracks elapsed time from request receipt to response sent and
      // exposes it on the reply, so we don't need our own onRequest hook.
      const duration = Math.round(reply.elapsedTime ?? 0);
      const path = request.url.split('?')[0] ?? request.url;
      const status = reply.statusCode;
      const capture = captureDisabled(cfg)
        ? null
        : buildFastifyCapture(request, reply, cfg);
      client.capture({
        ts: new Date().toISOString(),
        method: request.method,
        route: routeTemplate(request),
        path,
        status,
        duration_ms: duration,
        consumer: readConsumer(request, opts.consumerHeader),
        error: status >= 500 ? `HTTP ${status}` : null,
        validation_errors: request[VALIDATION_SLOT] ?? null,
        capture,
      });
    } catch {
      // Telemetry must never break the request path.
    }
  });

  done();
}

// Mark the plugin so Fastify registers its hooks at the root encapsulation
// context — a single `app.register(fastifyBeacon, { client })` then covers every
// route in the instance (the same trick `fastify-plugin` applies, without taking
// it as a dependency). Stamped at module load so it travels with the function.
(fastifyBeacon as unknown as Record<symbol, boolean>)[
  Symbol.for('skip-override')
] = true;
