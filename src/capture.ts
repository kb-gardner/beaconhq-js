// Opt-in request inspection — masking + bounding helpers for captured request/
// response headers and bodies. OFF by default: the framework adapters only call
// these when the host explicitly enables capture (captureHeaders /
// captureRequestBody / captureResponseBody). Everything here is fail-open: a
// throw is impossible by construction (defensive try/catch in the adapters), and
// these functions never read a stream or mutate the host's body handling — they
// operate only on values the adapter already has in hand.
//
// PRIVACY: when capture is enabled, masking is ON by default. Sensitive headers
// are redacted wholesale; common sensitive body fields are masked recursively in
// JSON. The deny lists are extensible and a custom masker can post-process.

/** The replacement token shown in place of a redacted/masked value. */
export const REDACTED = '[REDACTED]';

/** Default cap on a captured body, in characters (~bytes for ASCII). 16KB. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/**
 * Header names that are ALWAYS redacted by default when header capture is on.
 * Lowercased; matched case-insensitively. Extend via {@link CaptureConfig.denyHeaders}.
 */
export const DEFAULT_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-session-token',
  'x-access-token',
  'proxy-authorization',
  'www-authenticate',
];

/**
 * Body field names (object keys) that are masked by default when body capture is
 * on and the body is JSON. Lowercased; matched case-insensitively against each
 * key, recursively. Extend via {@link CaptureConfig.denyBodyFields}.
 */
export const DEFAULT_SENSITIVE_BODY_FIELDS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'client_secret',
  'authorization',
  'cookie',
  'card',
  'card_number',
  'cardnumber',
  'cvv',
  'cvc',
  'ssn',
  'pin',
  'private_key',
];

/** Content types we will capture as a body (text/JSON). Everything else is skipped. */
const CAPTURABLE_CONTENT_TYPE = /^(application\/(json|.*\+json|x-www-form-urlencoded)|text\/)/i;

/** Resolved capture configuration the adapters pass to the helpers. */
export interface CaptureConfig {
  captureHeaders: boolean;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  /** When false, NO masking is applied (advanced; not recommended). Default true. */
  maskSensitive: boolean;
  /** Extra header names to redact (lowercased + merged with the defaults). */
  denyHeaders: Set<string>;
  /** Header names to NEVER redact even if in the deny list (allow list). */
  allowHeaders: Set<string>;
  /** Extra body field names to mask (lowercased + merged with the defaults). */
  denyBodyFields: Set<string>;
  /** Max captured body size in bytes/chars before truncation. */
  maxBodyBytes: number;
  /** Optional final masker run over each captured body string. */
  bodyMasker?: (body: string, kind: 'request' | 'response') => string;
}

/** User-facing capture options (all optional). Absent fields fall back to defaults. */
export interface CaptureOptions {
  captureHeaders?: boolean;
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
  maskSensitive?: boolean;
  denyHeaders?: string[];
  allowHeaders?: string[];
  denyBodyFields?: string[];
  maxBodyBytes?: number;
  bodyMasker?: (body: string, kind: 'request' | 'response') => string;
}

/** Build a resolved CaptureConfig from user options. Capture is OFF unless asked. */
export function resolveCaptureConfig(opts: CaptureOptions = {}): CaptureConfig {
  return {
    captureHeaders: opts.captureHeaders ?? false,
    captureRequestBody: opts.captureRequestBody ?? false,
    captureResponseBody: opts.captureResponseBody ?? false,
    maskSensitive: opts.maskSensitive ?? true,
    denyHeaders: new Set(
      [...DEFAULT_SENSITIVE_HEADERS, ...(opts.denyHeaders ?? [])].map((h) =>
        h.toLowerCase(),
      ),
    ),
    allowHeaders: new Set((opts.allowHeaders ?? []).map((h) => h.toLowerCase())),
    denyBodyFields: new Set(
      [...DEFAULT_SENSITIVE_BODY_FIELDS, ...(opts.denyBodyFields ?? [])].map((f) =>
        f.toLowerCase(),
      ),
    ),
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    bodyMasker: opts.bodyMasker,
  };
}

/** True when NO capture flag is enabled (fast bail-out so adapters do zero work). */
export function captureDisabled(cfg: CaptureConfig): boolean {
  return (
    !cfg.captureHeaders && !cfg.captureRequestBody && !cfg.captureResponseBody
  );
}

/**
 * Mask a headers map into a plain `name -> value` object of strings. Multi-value
 * headers are joined with ", ". Sensitive names (deny list minus allow list) are
 * replaced wholesale with {@link REDACTED}. Never throws.
 */
export function maskHeaders(
  headers: Record<string, string | string[] | number | undefined> | Headers | undefined,
  cfg: CaptureConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const entries: Array<[string, string | string[] | number | undefined]> = [];
    if (!headers) return out;
    if (typeof (headers as Headers).forEach === 'function' && !Array.isArray(headers)) {
      // A WHATWG Headers object.
      (headers as Headers).forEach((value, key) => entries.push([key, value]));
    } else {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        entries.push([k, v as string | string[] | number | undefined]);
      }
    }
    for (const [name, rawValue] of entries) {
      if (rawValue === undefined) continue;
      const lower = name.toLowerCase();
      const sensitive =
        cfg.maskSensitive && cfg.denyHeaders.has(lower) && !cfg.allowHeaders.has(lower);
      const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
      out[name] = sensitive ? REDACTED : value;
    }
  } catch {
    // Header masking is best-effort; return whatever we accumulated.
  }
  return out;
}

/** Is this content type one we should capture as a (text) body? */
export function isCapturableContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  return CAPTURABLE_CONTENT_TYPE.test(contentType);
}

/**
 * Recursively mask sensitive keys in a parsed JSON value. Returns a NEW value
 * (does not mutate the input). Matching is case-insensitive on the key name.
 */
function maskJsonValue(value: unknown, cfg: CaptureConfig, depth = 0): unknown {
  if (depth > 50) return value; // guard pathological nesting
  if (Array.isArray(value)) {
    return value.map((v) => maskJsonValue(v, cfg, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (cfg.denyBodyFields.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = maskJsonValue(v, cfg, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Mask + truncate a captured body. `raw` is the body the adapter already has
 * (string, Buffer, or an already-parsed object); `contentType` gates capture to
 * text/JSON. Returns the masked, possibly-truncated string plus whether it was
 * truncated and the content type — or `null` when the body should NOT be captured
 * (wrong content type, empty, or unparseable binary). Never throws.
 */
export interface MaskedBody {
  body: string;
  truncated: boolean;
  contentType: string | null;
}

export function maskBody(
  raw: unknown,
  contentType: string | undefined | null,
  cfg: CaptureConfig,
  kind: 'request' | 'response',
): MaskedBody | null {
  try {
    if (raw === undefined || raw === null || raw === '') return null;
    if (!isCapturableContentType(contentType)) return null;

    const isJson = /json/i.test(contentType ?? '');
    let text: string;

    if (typeof raw === 'string') {
      text = raw;
      if (cfg.maskSensitive && isJson) {
        try {
          text = JSON.stringify(maskJsonValue(JSON.parse(raw), cfg));
        } catch {
          // Not valid JSON despite the header; keep the raw text (still masked
          // by the optional bodyMasker below).
        }
      }
    } else if (typeof (raw as { byteLength?: number }).byteLength === 'number') {
      // Buffer/Uint8Array: decode as utf-8 text (we only got here for text types).
      text = Buffer.from(raw as Uint8Array).toString('utf8');
      if (cfg.maskSensitive && isJson) {
        try {
          text = JSON.stringify(maskJsonValue(JSON.parse(text), cfg));
        } catch {
          /* keep raw text */
        }
      }
    } else if (typeof raw === 'object') {
      // Already-parsed object (e.g. express req.body). Mask then serialize.
      const masked = cfg.maskSensitive ? maskJsonValue(raw, cfg) : raw;
      text = JSON.stringify(masked);
    } else {
      return null;
    }

    if (cfg.bodyMasker) {
      try {
        text = cfg.bodyMasker(text, kind);
      } catch {
        /* custom masker must never break capture */
      }
    }

    let truncated = false;
    if (text.length > cfg.maxBodyBytes) {
      text = text.slice(0, cfg.maxBodyBytes);
      truncated = true;
    }
    return { body: text, truncated, contentType: contentType ?? null };
  } catch {
    return null;
  }
}
