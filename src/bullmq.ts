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
import type { Worker, Job, Queue } from 'bullmq';
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

/**
 * Schedule shape for PUT /v1/heartbeats/ensure — either a fixed interval or a
 * cron expression. Mirrored from the queue's repeatable-job definition.
 */
type EnsureSchedule =
  | { kind: 'interval'; interval_seconds: number }
  | { kind: 'cron'; cron_expr: string; timezone?: string };

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

  // --- new in 2b: zero-config, project-ingest-key driven ---
  /**
   * Project ingest key (the same key your `BeaconClient` uses). When set, jobs
   * that have NO mapped token are pinged **by name** via
   * `POST /v1/heartbeats/ping-by-name` (Bearer apiKey). Also required to use
   * {@link BeaconBullMQOptions.autoRegister}.
   */
  apiKey?: string;
  /**
   * Discover the queue's repeatable jobs and ensure a Beacon heartbeat per job
   * (schedule mirrored from BullMQ) on setup. Requires {@link apiKey}. Runs as a
   * background, fire-and-forget, fail-open task — it never blocks setup and a
   * failure (incl. the plan's heartbeat-cap 402) never aborts the worker or the
   * other jobs. Pings then route **by name**.
   */
  autoRegister?: { queue: Queue; graceSeconds?: number };
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
 * Ping a heartbeat BY NAME via POST /v1/heartbeats/ping-by-name (Bearer apiKey).
 * The project is resolved server-side from the key. Same body shape as the
 * token ping. Resolves on success; REJECTS on a network error, a non-2xx
 * response (incl. a 404 before the heartbeat exists — fail-open, self-heals on
 * the next run once ensure has landed), or a timeout. Callers catch (fail-open).
 */
export async function pingHeartbeatByName(
  base: string,
  apiKey: string,
  name: string,
  body: HeartbeatPingBody,
  timeoutMs: number,
): Promise<void> {
  const url = `${base}/v1/heartbeats/ping-by-name`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Beacon ping-by-name responded ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure (idempotent upsert) a Beacon heartbeat via PUT /v1/heartbeats/ensure
 * (Bearer apiKey). The body carries the name, the mirrored schedule, the grace
 * window, and a `managed_by` marker. Resolves on success; REJECTS on a network
 * error, a non-2xx response (incl. a 402 when over the plan heartbeat cap), or a
 * timeout. Callers catch per-job (fail-open).
 */
export async function ensureHeartbeat(
  base: string,
  apiKey: string,
  body: {
    name: string;
    schedule: EnsureSchedule;
    grace_seconds: number;
    managed_by: string;
  },
  timeoutMs: number,
): Promise<void> {
  const url = `${base}/v1/heartbeats/ensure`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Beacon heartbeat ensure responded ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A repeatable-job entry as returned by either `queue.getJobSchedulers()`
 * (BullMQ v5 newer) or `queue.getRepeatableJobs()` (older v5). We read these
 * fields defensively — both APIs expose a `name`, a millisecond `every`, and/or
 * a cron `pattern` (older API also surfaced `cron`/`tz`).
 */
interface RepeatableEntry {
  name?: string;
  every?: number | string;
  pattern?: string;
  cron?: string;
  tz?: string;
}

/**
 * Map a repeatable-job entry to a Beacon ensure schedule.
 * - `every` (ms) -> interval (>= 1s, rounded up).
 * - else `pattern`/`cron` -> cron (+ optional tz).
 * - neither -> null (caller skips it — can't monitor a scheduleless job).
 */
function scheduleFromEntry(entry: RepeatableEntry): EnsureSchedule | null {
  const everyMs =
    typeof entry.every === 'number'
      ? entry.every
      : typeof entry.every === 'string' && entry.every.trim() !== ''
        ? Number(entry.every)
        : NaN;
  if (Number.isFinite(everyMs) && everyMs > 0) {
    return { kind: 'interval', interval_seconds: Math.max(1, Math.ceil(everyMs / 1000)) };
  }
  const cronExpr = entry.pattern ?? entry.cron;
  if (typeof cronExpr === 'string' && cronExpr.trim() !== '') {
    return { kind: 'cron', cron_expr: cronExpr, timezone: entry.tz || undefined };
  }
  return null;
}

/**
 * Discover the queue's repeatable jobs and ensure a heartbeat per job. Prefers
 * the newer `getJobSchedulers()`; falls back to `getRepeatableJobs()` when it's
 * absent. Fail-open PER JOB: one ensure failing (network / 402-cap) never aborts
 * the others. The whole pass is awaited internally but kicked off un-awaited by
 * the caller (background fire-and-forget). Every error routes to `onError`.
 */
async function autoRegisterHeartbeats(
  base: string,
  apiKey: string,
  queue: Queue,
  graceSeconds: number,
  timeoutMs: number,
  onError: (err: unknown) => void,
): Promise<void> {
  let entries: RepeatableEntry[];
  try {
    const q = queue as unknown as {
      getJobSchedulers?: () => Promise<RepeatableEntry[]>;
      getRepeatableJobs?: () => Promise<RepeatableEntry[]>;
    };
    if (typeof q.getJobSchedulers === 'function') {
      entries = (await q.getJobSchedulers()) ?? [];
    } else if (typeof q.getRepeatableJobs === 'function') {
      entries = (await q.getRepeatableJobs()) ?? [];
    } else {
      throw new Error(
        'BullMQ queue exposes neither getJobSchedulers() nor getRepeatableJobs()',
      );
    }
  } catch (err) {
    // Discovery itself failed — nothing to ensure. Fail-open.
    safe(onError, err);
    return;
  }

  const managedBy = `sdk:${queue.name}`;
  for (const entry of entries) {
    const name = entry?.name;
    if (!name || typeof name !== 'string') {
      safe(onError, new Error('beaconBullMQ: skipping repeatable job with no stable name'));
      continue;
    }
    const schedule = scheduleFromEntry(entry);
    if (!schedule) {
      safe(
        onError,
        new Error(`beaconBullMQ: skipping job "${name}" — no interval/cron schedule found`),
      );
      continue;
    }
    try {
      await ensureHeartbeat(
        base,
        apiKey,
        { name, schedule, grace_seconds: graceSeconds, managed_by: managedBy },
        timeoutMs,
      );
    } catch (err) {
      // Per-job fail-open: a 402 cap or a network blip on one job must not
      // prevent the rest from being ensured.
      safe(onError, err);
    }
  }
}

/** Invoke an onError hook without letting it throw back into the caller. */
function safe(onError: (err: unknown) => void, err: unknown): void {
  try {
    onError(err);
  } catch {
    /* an onError that itself throws must not escape */
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
  const apiKey = opts.apiKey;

  // Config validation (loud, at setup). autoRegister needs the project ingest
  // key to call PUT /v1/heartbeats/ensure — using it without `apiKey` is a
  // programming error, so throw synchronously. (A ping-by-name without apiKey is
  // NOT an error — it's just a no-op per the routing rules below.)
  if (opts.autoRegister && !apiKey) {
    throw new Error(
      'beaconBullMQ: `autoRegister` requires `apiKey` (the project ingest key) — ' +
        'ensure cannot register heartbeats without it.',
    );
  }

  // Kick off auto-registration as a background, fire-and-forget task. The helper
  // returns synchronously (back-compat with 0.3.0): we do NOT await this, so the
  // worker is wired immediately and registration completes on its own. Any
  // failure (incl. a 402 cap) is fail-open and routed to onError.
  if (opts.autoRegister && apiKey) {
    const graceSeconds = opts.autoRegister.graceSeconds ?? 60;
    void autoRegisterHeartbeats(
      base,
      apiKey,
      opts.autoRegister.queue,
      graceSeconds,
      timeoutMs,
      onError,
    ).catch((err) => safe(onError, err));
  }

  /** Resolve a ping token for a job name: explicit map wins, then resolveToken. */
  function tokenFor(jobName: string | undefined): string | undefined {
    if (!jobName) return undefined;
    const mapped = heartbeats[jobName];
    if (mapped) return mapped;
    return resolveToken?.(jobName);
  }

  /** Fire a token ping without blocking the emitter; route failure to onError. */
  function fire(token: string, body: HeartbeatPingBody): void {
    // Intentionally not awaited: the emitter returns immediately. .catch() makes
    // the floating promise safe — no unhandled rejection, no throw into BullMQ.
    void pingHeartbeat(base, token, body, timeoutMs).catch((err) => safe(onError, err));
  }

  /** Fire a ping-by-name without blocking the emitter; route failure to onError. */
  function fireByName(name: string, body: HeartbeatPingBody): void {
    if (!apiKey) return;
    void pingHeartbeatByName(base, apiKey, name, body, timeoutMs).catch((err) =>
      safe(onError, err),
    );
  }

  /**
   * Route a ping for a job: (1) a resolved token pings by token (v1 path,
   * precedence preserved); (2) else with an apiKey, ping by name; (3) else
   * no-op (unmapped, no key).
   */
  function route(jobName: string | undefined, body: HeartbeatPingBody): void {
    const token = tokenFor(jobName);
    if (token) {
      fire(token, body);
      return;
    }
    if (jobName && apiKey) {
      fireByName(jobName, body);
    }
  }

  const onCompleted = (job: Job): void => {
    try {
      // Precedence: token wins; else ping-by-name (apiKey); else no-op.
      if (!job?.name) return;
      if (!tokenFor(job.name) && !apiKey) return;
      const body: HeartbeatPingBody = { status: 'success', source };
      // duration_ms = finishedOn - processedOn, clamped >= 0. Omit if it can't be
      // computed sanely (e.g. either timestamp missing).
      const finishedOn = job.finishedOn;
      const processedOn = job.processedOn;
      if (typeof finishedOn === 'number' && typeof processedOn === 'number') {
        const d = finishedOn - processedOn;
        if (Number.isFinite(d) && d >= 0) body.duration_ms = Math.round(d);
      }
      route(job.name, body);
    } catch (err) {
      // Resolving/inspecting the job must never throw into the emitter.
      safe(onError, err);
    }
  };

  const onFailed = (job: Job | undefined, err: unknown): void => {
    try {
      if (!pingOnFailure) return;
      // job may be undefined for some internal BullMQ failures -> nothing to map.
      // A failure can only be routed if there's a token OR an apiKey for the name.
      if (!job?.name) return;
      if (!tokenFor(job.name) && !apiKey) return;

      if (onlyFinalAttempt) {
        // Final attempt = attemptsMade has reached the configured attempts cap.
        const attemptsMade = job.attemptsMade ?? 0;
        const maxAttempts = job.opts?.attempts ?? 1;
        if (attemptsMade < maxAttempts) return; // a retry is still pending -> no ping
      }

      const body: HeartbeatPingBody = { status: 'fail', source };
      const exitCode = extractExitCode(err);
      if (exitCode !== undefined) body.exit_code = exitCode;
      route(job.name, body);
    } catch (e) {
      safe(onError, e);
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
