// beaconBullMQ — wire a BullMQ Worker to Beacon heartbeats with one call.
//
// Each successful job refreshes its monitor (reporting the run duration); each
// TERMINAL failure trips it fast. This is fire-and-forget and FAIL-OPEN: a Beacon
// outage, a bad token, or a slow network must NEVER affect your job execution. The
// listeners never await-block BullMQ's emitter and never throw back into it — any
// rejection/timeout is caught and routed to `onError` (default: swallowed), exactly
// mirroring the core BeaconClient's "telemetry must not break the host app" ethos.
//
// Usage:
//   import { Worker } from 'bullmq';
//   import { beaconBullMQ } from 'beaconhq/bullmq';
//
//   const worker = new Worker('emails', processor, { connection });
//   const detach = beaconBullMQ(worker, {
//     heartbeats: { 'send-digest': process.env.BEACON_DIGEST_TOKEN! },
//   });
//   // later: detach();
//
// The `bullmq` import below is TYPE-ONLY — this module has no runtime dependency on
// bullmq. bullmq is an optional peer dependency; install it only if you use this.
import type { Worker, Job } from 'bullmq';
import { DEFAULT_INGEST_URL } from './client.js';

// `node:os` is a static import (always present in Node, the SDK's target runtime).
// hostname() is still called inside a try/catch so an exotic runtime that stubs it
// out degrades to the plain `bullmq` source label rather than throwing.
import { hostname } from 'node:os';

/** Body accepted by POST /v1/heartbeats/ping/:token (validated server-side). */
interface HeartbeatPingBody {
  status?: 'success' | 'fail';
  duration_ms?: number;
  exit_code?: number;
  source?: string;
}

export interface BeaconBullMQOptions {
  /** Map of BullMQ job name -> per-heartbeat ping token. */
  heartbeats?: Record<string, string>;
  /**
   * Alternative to `heartbeats`: resolve a ping token from a job name. Consulted
   * after `heartbeats` (so `heartbeats` wins when both are provided).
   */
  resolveToken?: (jobName: string) => string | undefined;
  /** Ping `status:'fail'` on terminal job failure. Default true. */
  pingOnFailure?: boolean;
  /**
   * Only ping on the FINAL failed attempt, not on each retry. Default true — this
   * is what prevents retry flapping (a job that fails attempt 1, then succeeds on
   * attempt 2, should never trip the monitor).
   */
  onlyFinalAttempt?: boolean;
  /**
   * Origin/base to ping. Defaults to the same origin as {@link DEFAULT_INGEST_URL}
   * (the hosted Beacon). A trailing `/v1/ingest` or `/v1/heartbeats/ping[...]` is
   * stripped so you can pass either an origin or your configured ingest URL.
   */
  ingestUrl?: string;
  /** `source` label sent with each ping. Default `bullmq:${hostname}:${pid}`. */
  source?: string;
  /** Abort the ping request after this many ms. Default 5000. */
  timeoutMs?: number;
  /** Observability hook for ping failures. Default: swallow. Never re-thrown. */
  onError?: (err: unknown) => void;
}

/**
 * Derive the heartbeat-ping origin from a full ingest URL (or a bare origin).
 * `https://host/v1/ingest` -> `https://host`. We strip a trailing `/v1/ingest`
 * (the default ingest path) or any trailing slash so we always target the same
 * origin the request-telemetry client ships to.
 */
function deriveBase(ingestUrl: string): string {
  let base = ingestUrl.trim();
  // Drop a trailing /v1/ingest (with optional trailing slash) -> origin.
  base = base.replace(/\/v1\/ingest\/?$/i, '');
  // Defensive: if someone passes a full ping URL, drop that path too.
  base = base.replace(/\/v1\/heartbeats\/ping(\/[^/]*)?\/?$/i, '');
  // Strip any remaining trailing slash.
  base = base.replace(/\/+$/, '');
  return base;
}

/** Best-effort default source label: `bullmq:<hostname>:<pid>`, fail-soft to `bullmq`. */
function defaultSource(): string {
  try {
    const host = hostname();
    const pid = typeof process !== 'undefined' ? process.pid : undefined;
    if (host && pid != null) return `bullmq:${host}:${pid}`;
    if (host) return `bullmq:${host}`;
  } catch {
    // os/process unavailable — fall through to the plain label.
  }
  return 'bullmq';
}

/**
 * Fire a single heartbeat ping. Self-contained: uses the global `fetch` (Node 18+)
 * with an AbortController timeout. Resolves on success; REJECTS on a network error,
 * a non-2xx response, or a timeout — callers are expected to catch (fail-open).
 */
export async function pingHeartbeat(
  base: string,
  token: string,
  body: HeartbeatPingBody,
  timeoutMs: number,
): Promise<void> {
  const url = `${base}/v1/heartbeats/ping/${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Beacon heartbeat ping responded ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a numeric process-style exit code off an error, if it carries one
 * (`code` / `exitCode` / `exitcode`). Returns undefined otherwise (the field is
 * then omitted from the ping). String codes (e.g. Node's `'ECONNREFUSED'`) are
 * ignored — the server expects an integer.
 */
function extractExitCode(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ['code', 'exitCode', 'exitcode']) {
    const v = e[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
  }
  return undefined;
}

/**
 * Wire a BullMQ {@link Worker} to Beacon heartbeats. Returns a `detach()` that
 * removes the listeners this attached. Idempotent to call detach() more than once.
 */
export function beaconBullMQ(worker: Worker, opts: BeaconBullMQOptions): () => void {
  const heartbeats = opts.heartbeats ?? {};
  const resolveToken = opts.resolveToken;
  const pingOnFailure = opts.pingOnFailure ?? true;
  const onlyFinalAttempt = opts.onlyFinalAttempt ?? true;
  const base = deriveBase(opts.ingestUrl ?? DEFAULT_INGEST_URL);
  const source = opts.source ?? defaultSource();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const onError = opts.onError ?? (() => {});

  /** Resolve a ping token for a job name: explicit map wins, then resolveToken. */
  function tokenFor(jobName: string | undefined): string | undefined {
    if (!jobName) return undefined;
    const mapped = heartbeats[jobName];
    if (mapped) return mapped;
    return resolveToken?.(jobName);
  }

  /** Fire a ping without blocking the emitter; route any failure to onError. */
  function fire(token: string, body: HeartbeatPingBody): void {
    // Intentionally not awaited: the emitter returns immediately. .catch() makes
    // the floating promise safe — no unhandled rejection, no throw into BullMQ.
    void pingHeartbeat(base, token, body, timeoutMs).catch((err) => {
      try {
        onError(err);
      } catch {
        // An onError that itself throws must not escape either. Truly fail-open.
      }
    });
  }

  const onCompleted = (job: Job): void => {
    try {
      const token = tokenFor(job?.name);
      if (!token) return;
      const body: HeartbeatPingBody = { status: 'success', source };
      // duration_ms = finishedOn - processedOn, clamped >= 0. Omit if it can't be
      // computed sanely (e.g. either timestamp missing).
      const finishedOn = job.finishedOn;
      const processedOn = job.processedOn;
      if (typeof finishedOn === 'number' && typeof processedOn === 'number') {
        const d = finishedOn - processedOn;
        if (Number.isFinite(d) && d >= 0) body.duration_ms = Math.round(d);
      }
      fire(token, body);
    } catch (err) {
      // Resolving/inspecting the job must never throw into the emitter.
      try {
        onError(err);
      } catch {
        /* swallow */
      }
    }
  };

  const onFailed = (job: Job | undefined, err: unknown): void => {
    try {
      if (!pingOnFailure) return;
      // job may be undefined for some internal BullMQ failures -> nothing to map.
      const token = tokenFor(job?.name);
      if (!token) return;

      if (onlyFinalAttempt && job) {
        // Final attempt = attemptsMade has reached the configured attempts cap.
        const attemptsMade = job.attemptsMade ?? 0;
        const maxAttempts = job.opts?.attempts ?? 1;
        if (attemptsMade < maxAttempts) return; // a retry is still pending -> no ping
      }

      const body: HeartbeatPingBody = { status: 'fail', source };
      const exitCode = extractExitCode(err);
      if (exitCode !== undefined) body.exit_code = exitCode;
      fire(token, body);
    } catch (e) {
      try {
        onError(e);
      } catch {
        /* swallow */
      }
    }
  };

  worker.on('completed', onCompleted);
  worker.on('failed', onFailed);

  let detached = false;
  return function detach(): void {
    if (detached) return;
    detached = true;
    worker.off('completed', onCompleted);
    worker.off('failed', onFailed);
  };
}
