// BeaconClient — buffers request events and flushes them to the Beacon ingest
// API on an interval or when the buffer fills. Designed to be non-blocking and
// to NEVER throw into the host application: capture failures are swallowed and
// optionally surfaced via the `onError` hook.

/**
 * One structured request-validation failure (a single failing field). Derived
 * best-effort from the framework's validation error (Zod issues, NestJS
 * class-validator / BadRequestException messages, Fastify schema errors) and
 * shipped on {@link BeaconEvent.validation_errors} so Beacon can show, per
 * endpoint, which fields fail validation, with what messages, how often.
 */
export interface BeaconValidationError {
  /** Failing field path, e.g. "body.items.0.price" or "currency". */
  field: string;
  /** Human validation message, e.g. "Expected number, received string". */
  message: string;
  /** Optional machine code, e.g. "invalid_type". */
  type?: string | null;
}

export interface BeaconEvent {
  /** ISO 8601 timestamp of when the request completed. */
  ts: string;
  method: string;
  /** Route template, e.g. "/users/:id". Best-effort. */
  route: string;
  /** Concrete request path, e.g. "/users/123". */
  path: string;
  status: number;
  duration_ms: number;
  consumer?: string | null;
  error?: string | null;
  /**
   * Structured input-validation failures for this request (422/400). Optional and
   * best-effort — omitted unless the adapter could detect validation detail.
   */
  validation_errors?: BeaconValidationError[] | null;
  /**
   * Opt-in request inspection: masked + truncated request/response headers and
   * bodies. Present ONLY when the adapter was configured to capture (OFF by
   * default). All values here are already masked + size-bounded at the source.
   */
  capture?: BeaconCapture | null;
}

/**
 * Captured (masked, truncated) request/response headers + bodies for one request.
 * Shipped on {@link BeaconEvent.capture} only when capture is explicitly enabled.
 * Sensitive header values + body fields are already redacted at the source.
 */
export interface BeaconCapture {
  request_headers?: Record<string, string> | null;
  response_headers?: Record<string, string> | null;
  request_body?: string | null;
  response_body?: string | null;
  request_content_type?: string | null;
  response_content_type?: string | null;
  request_body_truncated?: boolean | null;
  response_body_truncated?: boolean | null;
}

/**
 * Default hosted ingest endpoint. With just an `apiKey`, a `BeaconClient` ships
 * to Beacon's managed ingest service — customers only need a project key. Set
 * `ingestUrl` to override (e.g. for a self-hosted Beacon).
 */
export const DEFAULT_INGEST_URL = 'https://ingest.beacon.skyware.dev/v1/ingest';

export interface BeaconClientOptions {
  /** Per-project ingest key (sent as `Authorization: Bearer <apiKey>`). */
  apiKey: string;
  /**
   * Full ingest endpoint, e.g. "https://beacon.example.com/v1/ingest".
   * Optional — defaults to the hosted endpoint {@link DEFAULT_INGEST_URL}.
   */
  ingestUrl?: string;
  /** Flush cadence in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Max buffered events before an eager flush. Default 100. */
  batchSize?: number;
  /** Hard cap on the buffer to bound memory if the network is down. Default 10000. */
  maxBufferSize?: number;
  /** Optional error hook for observability. Never required. */
  onError?: (err: unknown) => void;
  /** Inject a fetch implementation (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class BeaconClient {
  private readonly apiKey: string;
  private readonly ingestUrl: string;
  private readonly batchSize: number;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly fetchImpl: typeof fetch;

  private buffer: BeaconEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(opts: BeaconClientOptions) {
    if (!opts.apiKey) throw new Error('BeaconClient: apiKey is required');
    this.apiKey = opts.apiKey;
    // ingestUrl is optional: an empty/omitted value falls back to the hosted
    // endpoint so `new BeaconClient({ apiKey })` works with just a key.
    this.ingestUrl = opts.ingestUrl || DEFAULT_INGEST_URL;
    this.batchSize = opts.batchSize ?? 100;
    this.maxBufferSize = opts.maxBufferSize ?? 10_000;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.onError = opts.onError ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    this.start();
  }

  /** Enqueue an event. Non-blocking; triggers an eager flush at batchSize. */
  capture(event: BeaconEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // Drop oldest to bound memory; report via onError.
      this.buffer.shift();
      this.onError(new Error('Beacon buffer full; dropping oldest event'));
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Begin the periodic flush timer (unref'd so it never blocks process exit). */
  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't keep the event loop alive just for telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Flush buffered events. Safe to call concurrently; only one runs at a time. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await this.fetchImpl(this.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        // Re-queue on transient/server errors (not on 4xx auth/validation).
        if (res.status >= 500) this.buffer.unshift(...batch);
        this.onError(new Error(`Beacon ingest responded ${res.status}`));
      }
    } catch (err) {
      // Network failure: re-queue (bounded by maxBufferSize) and report.
      this.buffer.unshift(...batch);
      this.onError(err);
    } finally {
      this.flushing = false;
    }
  }

  /** Flush remaining events and stop the timer. Call on graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
