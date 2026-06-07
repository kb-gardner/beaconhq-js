// Unit tests for beaconBullMQ against a FAKE worker (a Node EventEmitter cast to
// the BullMQ Worker type) and a mocked global fetch. These assert the heartbeat
// contract the ping route enforces (ingest/src/routes/heartbeats.ts): the exact
// ping URL `/v1/heartbeats/ping/<token>`, the `{ status, duration_ms?, exit_code?,
// source }` body, the no-flapping-on-retry rule (no ping on a non-final attempt),
// no-op on an unmapped job, the resolveToken path, and the fail-open invariant —
// a rejected/timed-out ping NEVER throws into the worker's emitter.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Worker, Job } from 'bullmq';
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
}

/** Install a mock global fetch; record calls. Returns a handle + restore. */
function mockFetch(opts: { reject?: unknown } = {}) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (opts.reject !== undefined) throw opts.reject;
    calls.push({
      url: String(url),
      method: init?.method,
      body: JSON.parse((init?.body as string) ?? '{}'),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
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
