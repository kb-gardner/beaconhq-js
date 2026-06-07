// Unit tests for beaconBullMQ against a FAKE worker (a Node EventEmitter cast to
// the BullMQ Worker type) and a mocked global fetch. These assert the heartbeat
// contract the ping route enforces (ingest/src/routes/heartbeats.ts): the exact
// ping URL `/v1/heartbeats/ping/<token>`, the `{ status, duration_ms?, exit_code?,
// source }` body, the no-flapping-on-retry rule (no ping on a non-final attempt),
// no-op on an unmapped job, the resolveToken path, and the fail-open invariant —
// a rejected/timed-out ping NEVER throws into the worker's emitter.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Worker, Job, Queue } from 'bullmq';
import { beaconBullMQ } from '../src/bullmq.js';
import { DEFAULT_INGEST_URL } from '../src/client.js';

// The hosted origin (DEFAULT_INGEST_URL minus the trailing /v1/ingest).
const DEFAULT_BASE = 'https://ingest.beacon.skyware.dev';

/** A fake Worker: an EventEmitter that satisfies the .on/.off surface we use. */
function makeWorker(): Worker {
  return new EventEmitter() as unknown as Worker;
}

/** Build a minimal Job-like object. */
function makeJob(over: Partial<Job> = {}): Job {
  return {
    name: 'send-digest',
    processedOn: 1000,
    finishedOn: 1250,
    attemptsMade: 1,
    opts: { attempts: 1 },
    ...over,
  } as unknown as Job;
}

interface FetchCall {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
  auth: string | undefined;
}

/** Read the Authorization header off a RequestInit (object or Headers). */
function authOf(init?: RequestInit): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  return h.Authorization ?? h.authorization;
}

/**
 * Install a mock global fetch; record calls.
 * - `reject` makes EVERY call throw.
 * - `status` overrides the response status (e.g. 402 cap, 404 unknown name).
 * - `rejectMatch` makes only calls whose URL contains the substring throw.
 */
function mockFetch(
  opts: { reject?: unknown; status?: number; rejectMatch?: string } = {},
) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (opts.reject !== undefined) throw opts.reject;
    if (opts.rejectMatch && u.includes(opts.rejectMatch)) {
      throw new Error(`forced rejection for ${opts.rejectMatch}`);
    }
    calls.push({
      url: u,
      method: init?.method,
      body: JSON.parse((init?.body as string) ?? '{}'),
      auth: authOf(init),
    });
    const status = opts.status ?? 200;
    return new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return {
    calls,
    impl,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A fake Queue: a `name` + whichever discovery method(s) we want to expose. */
function makeQueue(opts: {
  name?: string;
  schedulers?: unknown[];
  repeatables?: unknown[];
}): Queue {
  const q: Record<string, unknown> = { name: opts.name ?? 'emails' };
  if (opts.schedulers !== undefined) {
    q.getJobSchedulers = vi.fn(async () => opts.schedulers);
  }
  if (opts.repeatables !== undefined) {
    q.getRepeatableJobs = vi.fn(async () => opts.repeatables);
  }
  return q as unknown as Queue;
}

/** Wait long enough for the background auto-register pass to settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

// Let the floating (un-awaited) ping promise settle so we can assert on it.
const flush = () => new Promise((r) => setTimeout(r, 0));

let fx: ReturnType<typeof mockFetch>;
afterEach(() => {
  fx?.restore();
});

describe('beaconBullMQ — success pings', () => {
  it('completed -> POST to /v1/heartbeats/ping/<token> with success + duration_ms', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    worker.emit('completed', makeJob({ processedOn: 1000, finishedOn: 1250 }));
    await flush();

    expect(fx.calls).toHaveLength(1);
    const call = fx.calls[0]!;
    expect(call.url).toBe(`${DEFAULT_BASE}/v1/heartbeats/ping/tok_abc`);
    expect(call.method).toBe('POST');
    expect(call.body.status).toBe('success');
    expect(call.body.duration_ms).toBe(250);
    expect(typeof call.body.source).toBe('string');
  });

  it('omits duration_ms when timestamps are missing/incoherent', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    // finishedOn missing -> cannot compute.
    worker.emit('completed', makeJob({ processedOn: 1000, finishedOn: undefined }));
    await flush();
    expect(fx.calls[0]!.body).not.toHaveProperty('duration_ms');

    // negative (finished before processed) -> omitted, not sent as a negative.
    worker.emit('completed', makeJob({ processedOn: 2000, finishedOn: 1000 }));
    await flush();
    expect(fx.calls[1]!.body).not.toHaveProperty('duration_ms');
  });

  it('unmapped job name -> no-op (fetch not called)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    worker.emit('completed', makeJob({ name: 'some-other-job' }));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();
  });

  it('resolveToken path resolves the token', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      resolveToken: (name) => (name === 'send-digest' ? 'tok_resolve' : undefined),
    });

    worker.emit('completed', makeJob());
    await flush();
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]!.url).toBe(`${DEFAULT_BASE}/v1/heartbeats/ping/tok_resolve`);
  });
});

describe('beaconBullMQ — failure pings', () => {
  it('terminal failure -> status:fail (+ exit_code when the error carries one)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    const err = Object.assign(new Error('boom'), { code: 17 });
    worker.emit('failed', makeJob({ attemptsMade: 3, opts: { attempts: 3 } }), err);
    await flush();

    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]!.body.status).toBe('fail');
    expect(fx.calls[0]!.body.exit_code).toBe(17);
  });

  it('omits exit_code when the error has no numeric code', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    // string code (e.g. ECONNREFUSED) is ignored — server wants an integer.
    const err = Object.assign(new Error('net'), { code: 'ECONNREFUSED' });
    worker.emit('failed', makeJob({ attemptsMade: 1, opts: { attempts: 1 } }), err);
    await flush();
    expect(fx.calls[0]!.body.status).toBe('fail');
    expect(fx.calls[0]!.body).not.toHaveProperty('exit_code');
  });

  it('non-final failure with onlyFinalAttempt -> NO ping (no retry flapping)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    // attempt 1 of 3 failed; two retries pending -> must NOT trip the monitor.
    worker.emit('failed', makeJob({ attemptsMade: 1, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();

    // final attempt (3 of 3) -> now it pings.
    worker.emit('failed', makeJob({ attemptsMade: 3, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]!.body.status).toBe('fail');
  });

  it('onlyFinalAttempt:false -> pings on every failed attempt', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      heartbeats: { 'send-digest': 'tok_abc' },
      onlyFinalAttempt: false,
    });

    worker.emit('failed', makeJob({ attemptsMade: 1, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.calls).toHaveLength(1);
  });

  it('pingOnFailure:false -> never pings on failure', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      heartbeats: { 'send-digest': 'tok_abc' },
      pingOnFailure: false,
    });

    worker.emit('failed', makeJob({ attemptsMade: 3, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();
  });

  it('undefined job in a failed event -> no token resolvable -> no-op', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    worker.emit('failed', undefined, new Error('internal'));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();
  });
});

describe('beaconBullMQ — fail-open + lifecycle', () => {
  it('fetch rejects -> no throw, onError invoked', async () => {
    const rejection = new Error('network down');
    fx = mockFetch({ reject: rejection });
    const onError = vi.fn();
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' }, onError });

    // Emitting must not throw even though the ping rejects.
    expect(() => worker.emit('completed', makeJob())).not.toThrow();
    await flush();
    expect(onError).toHaveBeenCalledWith(rejection);
  });

  it('timeout aborts the request and routes to onError (no throw)', async () => {
    // fetch that respects the abort signal.
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }) as unknown as typeof fetch;

    const onError = vi.fn();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      heartbeats: { 'send-digest': 'tok_abc' },
      timeoutMs: 5,
      onError,
    });
    worker.emit('completed', makeJob());
    await new Promise((r) => setTimeout(r, 25));
    expect(onError).toHaveBeenCalledTimes(1);
    globalThis.fetch = original;
  });

  it('default onError swallows a rejection (no unhandled rejection / throw)', async () => {
    fx = mockFetch({ reject: new Error('boom') });
    const worker = makeWorker();
    beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });
    expect(() => worker.emit('completed', makeJob())).not.toThrow();
    await flush();
    // Reaching here without an unhandled rejection is the assertion.
    expect(true).toBe(true);
  });

  it('detach() removes both listeners (post-detach events -> no fetch)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    const detach = beaconBullMQ(worker, { heartbeats: { 'send-digest': 'tok_abc' } });

    detach();
    worker.emit('completed', makeJob());
    worker.emit('failed', makeJob({ attemptsMade: 3, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();

    // detach is idempotent.
    expect(() => detach()).not.toThrow();
  });

  it('custom ingestUrl derives the right origin (strips /v1/ingest)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      heartbeats: { 'send-digest': 'tok_abc' },
      ingestUrl: 'https://beacon.internal.example.com/v1/ingest',
    });
    worker.emit('completed', makeJob());
    await flush();
    expect(fx.calls[0]!.url).toBe(
      'https://beacon.internal.example.com/v1/heartbeats/ping/tok_abc',
    );
  });

  it('custom source label is sent verbatim', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      heartbeats: { 'send-digest': 'tok_abc' },
      source: 'worker-7',
    });
    worker.emit('completed', makeJob());
    await flush();
    expect(fx.calls[0]!.body.source).toBe('worker-7');
  });

  it('DEFAULT_INGEST_URL is the expected hosted origin (sanity)', () => {
    expect(DEFAULT_INGEST_URL).toBe(`${DEFAULT_BASE}/v1/ingest`);
  });
});

// ---------------------------------------------------------------------------
// Phase 2b — zero-config auto-register + ping-by-name (project ingest key).
// ---------------------------------------------------------------------------

const ENSURE_URL = `${DEFAULT_BASE}/v1/heartbeats/ensure`;
const PING_BY_NAME_URL = `${DEFAULT_BASE}/v1/heartbeats/ping-by-name`;

describe('beaconBullMQ — autoRegister (ensure)', () => {
  it('getJobSchedulers (interval + cron) -> ensure per job, right URL/schedule/managed_by/grace', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    const queue = makeQueue({
      name: 'emails',
      schedulers: [
        { name: 'send-digest', every: 60_000 },
        { name: 'nightly-report', pattern: '0 0 * * *', tz: 'America/Denver' },
      ],
    });

    beaconBullMQ(worker, { apiKey: 'key_proj', autoRegister: { queue, graceSeconds: 90 } });
    await settle();

    const ensures = fx.calls.filter((c) => c.url === ENSURE_URL);
    expect(ensures).toHaveLength(2);
    for (const c of ensures) {
      expect(c.method).toBe('PUT');
      expect(c.auth).toBe('Bearer key_proj');
      expect(c.body.managed_by).toBe('sdk:emails');
      expect(c.body.grace_seconds).toBe(90);
    }

    const interval = ensures.find((c) => c.body.name === 'send-digest')!;
    expect(interval.body.schedule).toEqual({ kind: 'interval', interval_seconds: 60 });

    const cron = ensures.find((c) => c.body.name === 'nightly-report')!;
    expect(cron.body.schedule).toEqual({
      kind: 'cron',
      cron_expr: '0 0 * * *',
      timezone: 'America/Denver',
    });
  });

  it('rounds sub-second / fractional intervals up to >= 1s', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    const queue = makeQueue({
      schedulers: [
        { name: 'fast', every: 250 }, // 0.25s -> 1s floor
        { name: 'oddly', every: 1500 }, // 1.5s -> ceil 2s
      ],
    });
    beaconBullMQ(worker, { apiKey: 'k', autoRegister: { queue } });
    await settle();

    const ensures = fx.calls.filter((c) => c.url === ENSURE_URL);
    expect(ensures.find((c) => c.body.name === 'fast')!.body.schedule).toEqual({
      kind: 'interval',
      interval_seconds: 1,
    });
    expect(ensures.find((c) => c.body.name === 'oddly')!.body.schedule).toEqual({
      kind: 'interval',
      interval_seconds: 2,
    });
  });

  it('falls back to getRepeatableJobs when getJobSchedulers is absent', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    const queue = makeQueue({
      name: 'reports',
      repeatables: [{ name: 'weekly', cron: '0 9 * * 1' }],
      // no schedulers key -> getJobSchedulers undefined
    });

    beaconBullMQ(worker, { apiKey: 'k', autoRegister: { queue } });
    await settle();

    const ensures = fx.calls.filter((c) => c.url === ENSURE_URL);
    expect(ensures).toHaveLength(1);
    expect(ensures[0]!.body.name).toBe('weekly');
    expect(ensures[0]!.body.schedule).toEqual({ kind: 'cron', cron_expr: '0 9 * * 1' });
    expect(ensures[0]!.body.grace_seconds).toBe(60); // default grace
    expect(ensures[0]!.body.managed_by).toBe('sdk:reports');
  });

  it('skips entries with no name or no schedule (others still ensured)', async () => {
    fx = mockFetch();
    const onError = vi.fn();
    const worker = makeWorker();
    const queue = makeQueue({
      schedulers: [
        { every: 30_000 }, // no name -> skip
        { name: 'no-schedule' }, // no interval/cron -> skip
        { name: 'good', every: 30_000 }, // ensured
      ],
    });

    beaconBullMQ(worker, { apiKey: 'k', autoRegister: { queue }, onError });
    await settle();

    const ensures = fx.calls.filter((c) => c.url === ENSURE_URL);
    expect(ensures).toHaveLength(1);
    expect(ensures[0]!.body.name).toBe('good');
    // two benign skip notes routed to onError.
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('autoRegister without apiKey -> throws synchronously', () => {
    const worker = makeWorker();
    const queue = makeQueue({ schedulers: [{ name: 'x', every: 1000 }] });
    expect(() => beaconBullMQ(worker, { autoRegister: { queue } })).toThrow(/apiKey/);
  });

  it('ensure failure (402 cap) is fail-open: worker still wired, onError fired, others ensured', async () => {
    // 402 on the FIRST ensure; the second must still go out.
    let n = 0;
    const original = globalThis.fetch;
    const calls: FetchCall[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === ENSURE_URL) {
        n += 1;
        if (n === 1) {
          return new Response('{"error":"cap"}', { status: 402 });
        }
      }
      calls.push({
        url: u,
        method: init?.method,
        body: JSON.parse((init?.body as string) ?? '{}'),
        auth: authOf(init),
      });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const onError = vi.fn();
    const worker = makeWorker();
    const queue = makeQueue({
      schedulers: [
        { name: 'capped', every: 60_000 },
        { name: 'fine', every: 60_000 },
      ],
    });

    const detach = beaconBullMQ(worker, {
      apiKey: 'k',
      autoRegister: { queue },
      heartbeats: { 'after-reg': 'tok_x' },
      onError,
    });
    await settle();

    // The 402 was routed to onError, but the second ensure still landed.
    expect(onError).toHaveBeenCalledTimes(1);
    const ensures = calls.filter((c) => c.url === ENSURE_URL);
    expect(ensures).toHaveLength(1);
    expect(ensures[0]!.body.name).toBe('fine');

    // Worker listeners are still attached — a token ping after a failed reg works.
    worker.emit('completed', makeJob({ name: 'after-reg' }));
    await settle();
    expect(calls.some((c) => c.url.includes('/v1/heartbeats/ping/tok_x'))).toBe(true);

    detach();
    globalThis.fetch = original;
  });

  it('discovery itself rejecting -> fail-open, onError fired, worker still wired', async () => {
    fx = mockFetch();
    const onError = vi.fn();
    const worker = makeWorker();
    const queue = { name: 'q', getJobSchedulers: vi.fn(async () => { throw new Error('redis down'); }) } as unknown as Queue;

    beaconBullMQ(worker, { apiKey: 'k', autoRegister: { queue }, onError });
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    // no ensure calls, but the worker is still usable via ping-by-name.
    worker.emit('completed', makeJob({ name: 'send-digest' }));
    await settle();
    expect(fx.calls.some((c) => c.url === PING_BY_NAME_URL)).toBe(true);
  });

  it('custom ingestUrl flows through to ensure', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    const queue = makeQueue({ schedulers: [{ name: 'x', every: 60_000 }] });
    beaconBullMQ(worker, {
      apiKey: 'k',
      ingestUrl: 'https://beacon.internal.example.com/v1/ingest',
      autoRegister: { queue },
    });
    await settle();
    expect(fx.calls[0]!.url).toBe('https://beacon.internal.example.com/v1/heartbeats/ensure');
  });
});

describe('beaconBullMQ — ping-by-name routing (apiKey)', () => {
  it('completed with apiKey + no token -> POST /v1/heartbeats/ping-by-name (Bearer, body)', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { apiKey: 'key_proj' });

    worker.emit('completed', makeJob({ name: 'send-digest', processedOn: 1000, finishedOn: 1400 }));
    await flush();

    const c = fx.calls.find((x) => x.url === PING_BY_NAME_URL)!;
    expect(c).toBeTruthy();
    expect(c.method).toBe('POST');
    expect(c.auth).toBe('Bearer key_proj');
    expect(c.body.name).toBe('send-digest');
    expect(c.body.status).toBe('success');
    expect(c.body.duration_ms).toBe(400);
    expect(typeof c.body.source).toBe('string');
  });

  it('token present -> still pings BY TOKEN (v1 precedence), not by name', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      apiKey: 'key_proj',
      heartbeats: { 'send-digest': 'tok_abc' },
    });

    worker.emit('completed', makeJob({ name: 'send-digest' }));
    await flush();

    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]!.url).toBe(`${DEFAULT_BASE}/v1/heartbeats/ping/tok_abc`);
    expect(fx.calls.some((c) => c.url === PING_BY_NAME_URL)).toBe(false);
  });

  it('no token + no apiKey -> no-op', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {});
    worker.emit('completed', makeJob({ name: 'unmapped' }));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();
  });

  it('terminal failure with apiKey + no token -> ping-by-name status:fail', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { apiKey: 'key_proj' });

    const err = Object.assign(new Error('boom'), { code: 9 });
    worker.emit('failed', makeJob({ name: 'send-digest', attemptsMade: 1, opts: { attempts: 1 } }), err);
    await flush();

    const c = fx.calls.find((x) => x.url === PING_BY_NAME_URL)!;
    expect(c.body.status).toBe('fail');
    expect(c.body.exit_code).toBe(9);
  });

  it('non-final failure with apiKey + onlyFinalAttempt -> NO ping-by-name', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, { apiKey: 'key_proj' });
    worker.emit('failed', makeJob({ name: 'send-digest', attemptsMade: 1, opts: { attempts: 3 } }), new Error('x'));
    await flush();
    expect(fx.impl).not.toHaveBeenCalled();
  });

  it('ping-by-name 404 (heartbeat not yet ensured) is fail-open -> onError, no throw', async () => {
    fx = mockFetch({ status: 404 });
    const onError = vi.fn();
    const worker = makeWorker();
    beaconBullMQ(worker, { apiKey: 'key_proj', onError });
    expect(() => worker.emit('completed', makeJob({ name: 'send-digest' }))).not.toThrow();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('custom ingestUrl flows through to ping-by-name', async () => {
    fx = mockFetch();
    const worker = makeWorker();
    beaconBullMQ(worker, {
      apiKey: 'key_proj',
      ingestUrl: 'https://beacon.internal.example.com/v1/ingest',
    });
    worker.emit('completed', makeJob({ name: 'send-digest' }));
    await flush();
    expect(fx.calls[0]!.url).toBe(
      'https://beacon.internal.example.com/v1/heartbeats/ping-by-name',
    );
  });
});
