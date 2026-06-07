// Best-effort, fail-open extraction of structured request-validation failures
// from the shapes the common JS frameworks expose. Every extractor is defensive:
// it returns `undefined` (not a throw) when it can't find a recognizable shape, so
// a caller can simply spread `validation_errors` onto a BeaconEvent and never risk
// breaking the request path.
//
// Supported shapes (see per-framework adapters for where they come from):
//   - Zod:            ZodError.issues  -> [{ path: (string|number)[], message, code }]
//   - class-validator: NestJS BadRequestException response.message string[] (the
//                      default ValidationPipe formats each failure as a message)
//   - Fastify schema:  the FST_ERR_VALIDATION error's `.validation` AJV array
//                      ([{ instancePath, message, keyword, params }]) or the
//                      serialized `{ statusCode, message }` 400 body.
import type { BeaconValidationError } from './client.js';

// Caps so a pathological payload can't bloat an event. Mirrors the server-side
// MAX_VALIDATION_ERRORS backstop; the server also length-bounds each string.
export const MAX_VALIDATION_ERRORS = 50;
const MAX_FIELD_LEN = 512;
const MAX_MESSAGE_LEN = 1024;
const MAX_TYPE_LEN = 256;

function clamp(s: unknown, max: number): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length > max ? str.slice(0, max) : str;
}

// Normalize + cap a raw list of {field,message,type?} into the stored shape.
// Drops entries with no field or message. Returns undefined when nothing usable.
function normalize(
  raw: Array<{ field?: unknown; message?: unknown; type?: unknown }>,
): BeaconValidationError[] | undefined {
  const out: BeaconValidationError[] = [];
  for (const item of raw) {
    if (out.length >= MAX_VALIDATION_ERRORS) break;
    const field = clamp(item.field, MAX_FIELD_LEN);
    const message = clamp(item.message, MAX_MESSAGE_LEN);
    if (!field || !message) continue;
    const ve: BeaconValidationError = { field, message };
    if (item.type != null && String(item.type) !== '') {
      ve.type = clamp(item.type, MAX_TYPE_LEN);
    }
    out.push(ve);
  }
  return out.length > 0 ? out : undefined;
}

// ---- Zod ------------------------------------------------------------------
// A ZodError carries `.issues: [{ path, message, code }]`. We don't import zod;
// we duck-type the shape so this works with any zod version (and with Hono's
// zValidator, which throws/forwards the same error).
interface ZodIssueLike {
  path?: Array<string | number>;
  message?: string;
  code?: string;
}
interface ZodErrorLike {
  issues?: ZodIssueLike[];
}

export function fromZodError(err: unknown): BeaconValidationError[] | undefined {
  const issues = (err as ZodErrorLike | undefined)?.issues;
  if (!Array.isArray(issues)) return undefined;
  return normalize(
    issues.map((i) => ({
      field: Array.isArray(i.path) && i.path.length > 0 ? i.path.join('.') : '(root)',
      message: i.message,
      type: i.code,
    })),
  );
}

// Some Hono zValidator setups hand the result `{ success:false, error: ZodError }`
// to a hook rather than throwing. Accept either the ZodError or that wrapper.
export function fromZodResult(result: unknown): BeaconValidationError[] | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { success?: boolean; error?: unknown };
  if (r.success === false && r.error) return fromZodError(r.error);
  return fromZodError(result);
}

// ---- class-validator (NestJS) --------------------------------------------
// Nest's default ValidationPipe throws BadRequestException whose response is
// `{ statusCode:400, message: string[], error:'Bad Request' }`. Each message is a
// human constraint string like "currency should not be empty". The field name is
// the leading token of the message (class-validator messages start with the
// property name), which we extract best-effort.
interface NestExceptionLike {
  getStatus?: () => number;
  status?: number;
  getResponse?: () => unknown;
  response?: unknown;
}

function fieldFromConstraintMessage(message: string): string {
  // class-validator default messages lead with the property name, e.g.
  // "email must be an email" / "items.0.price must be a number". Take the first
  // whitespace-delimited token; fall back to the whole message if empty.
  const token = message.trim().split(/\s+/)[0] ?? '';
  return token || message;
}

export function fromNestException(err: unknown): BeaconValidationError[] | undefined {
  const e = err as NestExceptionLike | undefined;
  if (!e) return undefined;
  const status = typeof e.getStatus === 'function' ? e.getStatus() : e.status;
  if (status !== 400) return undefined;
  const resp =
    typeof e.getResponse === 'function' ? e.getResponse() : e.response;
  let messages: unknown;
  if (resp && typeof resp === 'object') {
    messages = (resp as { message?: unknown }).message;
  } else {
    messages = resp;
  }
  if (typeof messages === 'string') messages = [messages];
  if (!Array.isArray(messages)) return undefined;
  return normalize(
    (messages as unknown[])
      .filter((m): m is string => typeof m === 'string')
      .map((m) => ({ field: fieldFromConstraintMessage(m), message: m })),
  );
}

// ---- Fastify schema validation -------------------------------------------
// On a schema failure Fastify attaches an AJV-style `.validation` array to the
// error: [{ instancePath, message, keyword, params:{missingProperty?} }]. The
// reply body is also the serialized 400 `{ message }`, but the structured array on
// the error object is richer, so prefer it when present.
interface AjvErrorLike {
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
  message?: string;
  params?: { missingProperty?: string; [k: string]: unknown };
}
interface FastifyValidationErrorLike {
  validation?: AjvErrorLike[];
  validationContext?: string;
}

function ajvField(e: AjvErrorLike, context: string | undefined): string {
  // instancePath is like "/items/0/price"; a required-property failure carries an
  // empty instancePath plus params.missingProperty. Build a dotted path, prefixing
  // the validation context (body/params/querystring/headers) when known.
  let path = (e.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.');
  if (e.keyword === 'required' && e.params?.missingProperty) {
    path = path ? `${path}.${e.params.missingProperty}` : e.params.missingProperty;
  }
  if (!path) path = '(root)';
  return context ? `${context}.${path}` : path;
}

export function fromFastifyError(err: unknown): BeaconValidationError[] | undefined {
  const e = err as FastifyValidationErrorLike | undefined;
  if (!e || !Array.isArray(e.validation)) return undefined;
  return normalize(
    e.validation.map((v) => ({
      field: ajvField(v, e.validationContext),
      message: v.message ?? 'validation failed',
      type: v.keyword,
    })),
  );
}
