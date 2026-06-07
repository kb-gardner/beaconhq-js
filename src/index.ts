// beaconhq — Beacon Node client SDK.
//
// Core client buffers + ships request events to the Beacon ingest API; framework
// middleware auto-capture method/route/path/status/duration/errors. The raw HTTP
// contract in docs/ingest-contract.md is the language-agnostic source of truth;
// this SDK is the convenience wrapper for JS/TS services.
export { BeaconClient, DEFAULT_INGEST_URL } from './client.js';
export type {
  BeaconEvent,
  BeaconClientOptions,
  BeaconValidationError,
  BeaconCapture,
} from './client.js';
// Opt-in request-inspection capture (masking + bounding). Exported so apps can
// reuse the maskers or feed custom capture into a BeaconEvent themselves.
export {
  resolveCaptureConfig,
  maskHeaders,
  maskBody,
  isCapturableContentType,
  REDACTED,
  DEFAULT_SENSITIVE_HEADERS,
  DEFAULT_SENSITIVE_BODY_FIELDS,
  DEFAULT_MAX_BODY_BYTES,
} from './capture.js';
export type {
  CaptureOptions,
  CaptureConfig,
  MaskedBody,
} from './capture.js';
// Validation-error extractors (best-effort, fail-open). Exported so apps can
// capture validation detail from frameworks/spots the adapters don't auto-hook.
export {
  fromZodError,
  fromZodResult,
  fromNestException,
  fromFastifyError,
} from './validation.js';
export { beaconHono } from './hono.js';
export type { BeaconHonoOptions } from './hono.js';
export { beaconExpress } from './express.js';
export type { BeaconExpressOptions } from './express.js';
export { fastifyBeacon } from './fastify.js';
export type { BeaconFastifyOptions } from './fastify.js';
export { beaconKoa } from './koa.js';
export type { BeaconKoaOptions } from './koa.js';
export { BeaconInterceptor, beaconNest } from './nestjs.js';
export type { BeaconNestOptions } from './nestjs.js';
