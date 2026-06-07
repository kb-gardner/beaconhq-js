// Unit tests for the core BeaconClient against an injected mock fetch (no network).
//
// These assert the contract a real Beacon ingest server enforces
// (ingest/src/lib/validation.ts): the exact payload field names/types, the
// `{ events: [...] }` batch shape and auth/content-type headers, batch-fill flush,
// interval flush, manual flush, graceful-shutdown flush, the requeue-on-5xx /
// drop-on-4xx policy, the bounded re-queue on network failure, and the invariant
// that transport errors NEVER raise into the host app.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient, DEFAULT_INGEST_URL } from '../src/client.js';
import {
  EXPECTED_KEYS,
  ISO_OFFSET_RE,
  makeMockFetch,
  sampleEvent,
} from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

// Build a client wired to a mock fetch, with a long interval by default so timing
// is explicit per-test (mirrors sdk-py's make_client).
function makeClient(
  fetchImpl: typeof fetch,
  opts: Partial<ConstructorParameters<typeof BeaconClient>[0]> = {},
) {
  return new BeaconClient({
    ingestUrl: 'https://beacon.test/v1/ingest',
    apiKey: 'test-key',
    fetchImpl,
    flushIntervalMs: 999_000,
    ...opts,
  });
}

describe('payload + transport contract', () => {
  it('payload shape matches the ingest contract exactly (fields + types)', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl);
    client.capture(sampleEvent());
    await client.flush();

    expect(mock.sentEvents).toHaveLength(1);
    const ev = mock.sentEvents[0]!;

    // Exact field set — no extras (e.g. no `meta`), nothing missing.
    expect(Object.keys(ev).sort()).toEqual(EXPECTED_KEYS);
    // Types per the server schema.
    expect(typeof ev.ts).toBe('string');
    expect(ev.ts).toMatch(ISO_OFFSET_RE);
    expect(typeof ev.method).toBe('string');
    expect(typeof ev.route).toBe('string');
    expect(typeof ev.path).toBe('string');
    expect(typeof ev.status).toBe('number');
    expect(Number.isInteger(ev.status)).toBe(true);
    expect(typeof ev.duration_ms).toBe('number');
    expect(Number.isInteger(ev.duration_ms)).toBe(true);
    expect(ev.consumer).toBe('acme');
    expect(ev.error).toBeNull();

    await client.shutdown();
  });

  it('request body is batched under the `events` key', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl);
    client.capture(sampleEvent({ path: '/a' }));
    client.capture(sampleEvent({ path: '/b' }));
    await client.flush();

    expect(mock.calls).toHaveLength(1);
    const body = mock.calls[0]!.body;
    expect(Object.keys(body)).toEqual(['events']);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.map((e) => e.path)).toEqual(['/a', '/b']);

    await client.shutdown();
  });

  it('sends Authorization bearer + Content-Type headers and POSTs to ingestUrl', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, { apiKey: 'sekret-123' });
    client.capture(sampleEvent());
    await client.flush();

    const call = mock.calls[0]!;
    expect(call.url).toBe('https://beacon.test/v1/ingest');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer sekret-123');
    expect(call.headers['Content-Type']).toBe('application/json');

    await client.shutdown();
  });

  it('always emits consumer and error keys (present-as-null when absent)', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl);
    client.capture(sampleEvent({ consumer: null, error: null }));
    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect('consumer' in ev).toBe(true);
    expect(ev.consumer).toBeNull();
    expect('error' in ev).toBe(true);
    expect(ev.error).toBeNull();
    await client.shutdown();
  });
});

describe('buffering + flush', () => {
  it('eager-flushes when the buffer hits batchSize', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, { batchSize: 5 });
    for (let i = 0; i < 4; i++) client.capture(sampleEvent());
    // Under batchSize: nothing flushed yet.
    expect(mock.sentEvents).toHaveLength(0);

    client.capture(sampleEvent()); // 5th -> eager flush (fire-and-forget)
    // capture() triggers `void this.flush()`; let the microtasks settle.
    await vi.waitFor(() => expect(mock.sentEvents).toHaveLength(5));

    await client.shutdown();
  });

  it('flushes on the interval timer (fake timers)', async () => {
    vi.useFakeTimers();
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, {
      batchSize: 1000,
      flushIntervalMs: 5000,
    });
    client.capture(sampleEvent());
    // Well under batchSize -> no eager flush.
    expect(mock.sentEvents).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000); // fire one interval
    expect(mock.sentEvents).toHaveLength(1);

    await client.shutdown();
  });

  it('manual flush() ships buffered events', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, { batchSize: 1000 });
    client.capture(sampleEvent());
    expect(mock.sentEvents).toHaveLength(0);
    await client.flush();
    expect(mock.sentEvents).toHaveLength(1);
    await client.shutdown();
  });

  it('shutdown() performs a final flush and stops the timer', async () => {
    vi.useFakeTimers();
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, {
      batchSize: 1000,
      flushIntervalMs: 5000,
    });
    client.capture(sampleEvent());
    expect(mock.sentEvents).toHaveLength(0);

    await client.shutdown();
    expect(mock.sentEvents).toHaveLength(1);

    // Timer was cleared: advancing time produces no further flushes.
    client.capture(sampleEvent());
    await vi.advanceTimersByTimeAsync(50_000);
    expect(mock.sentEvents).toHaveLength(1);
  });

  it('flush() on an empty buffer is a no-op (no fetch)', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl);
    await client.flush();
    expect(mock.calls).toHaveLength(0);
    await client.shutdown();
  });
});

describe('resilience', () => {
  it('re-queues the batch on a network error and never throws into the caller', async () => {
    const mock = makeMockFetch();
    const onError = vi.fn();
    const client = makeClient(mock.impl, { batchSize: 1000, onError });
    client.capture(sampleEvent());

    mock.setNextError(new Error('network down'));
    // Must not reject despite the transport blowing up.
    await expect(client.flush()).resolves.toBeUndefined();
    expect(mock.sentEvents).toHaveLength(0); // nothing accepted
    expect(onError).toHaveBeenCalledTimes(1);

    // Event was re-queued; a later successful flush ships it.
    await client.flush();
    expect(mock.sentEvents).toHaveLength(1);
    await client.shutdown();
  });

  it('re-queues on a 5xx response', async () => {
    const mock = makeMockFetch();
    const onError = vi.fn();
    const client = makeClient(mock.impl, { batchSize: 1000, onError });
    client.capture(sampleEvent());

    mock.setNextStatus(503);
    await client.flush();
    expect(mock.sentEvents).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);

    // Recovered: a later 200 delivers it.
    await client.flush();
    expect(mock.sentEvents).toHaveLength(1);
    await client.shutdown();
  });

  it('does NOT retry a 4xx response (auth/validation -> dropped)', async () => {
    const mock = makeMockFetch();
    const onError = vi.fn();
    const client = makeClient(mock.impl, { batchSize: 1000, onError });
    client.capture(sampleEvent());

    mock.setNextStatus(400);
    await client.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![0])).toContain('400');

    // Even after recovery, the dropped event is gone (not re-queued).
    await client.flush();
    expect(mock.sentEvents).toHaveLength(0);
    expect(mock.calls).toHaveLength(1); // no second fetch — buffer was empty
    await client.shutdown();
  });

  it('bounds the buffer to maxBufferSize, dropping the oldest', async () => {
    const mock = makeMockFetch();
    const onError = vi.fn();
    const client = makeClient(mock.impl, {
      batchSize: 1000,
      maxBufferSize: 2,
      onError,
    });
    client.capture(sampleEvent({ path: '/a' }));
    client.capture(sampleEvent({ path: '/b' }));
    client.capture(sampleEvent({ path: '/c' })); // evicts /a

    await client.flush();
    expect(mock.sentEvents.map((e) => e.path)).toEqual(['/b', '/c']);
    expect(
      onError.mock.calls.some((c) => String(c[0]).includes('buffer full')),
    ).toBe(true);
    await client.shutdown();
  });

  it('capture() never throws even if the buffer is overflowing', async () => {
    const mock = makeMockFetch();
    const client = makeClient(mock.impl, { batchSize: 1000, maxBufferSize: 1 });
    expect(() => {
      client.capture(sampleEvent({ path: '/a' }));
      client.capture(sampleEvent({ path: '/b' }));
    }).not.toThrow();
    await client.shutdown();
  });

  it('onError is invoked on failure (network + 5xx + 4xx all surface)', async () => {
    const mock = makeMockFetch();
    const onError = vi.fn();
    const client = makeClient(mock.impl, { batchSize: 1000, onError });

    client.capture(sampleEvent());
    mock.setNextError(new Error('boom'));
    await client.flush();

    mock.setNextStatus(503);
    await client.flush();

    mock.setNextStatus(401);
    await client.flush();

    expect(onError).toHaveBeenCalledTimes(3);
    await client.shutdown();
  });
});

describe('construction validation', () => {
  it('throws when apiKey is missing/empty', () => {
    const mock = makeMockFetch();
    expect(
      () =>
        new BeaconClient({
          ingestUrl: 'https://x',
          apiKey: '',
          fetchImpl: mock.impl,
        }),
    ).toThrow(/apiKey/);
  });

  it('defaults ingestUrl to the hosted endpoint when omitted', async () => {
    const mock = makeMockFetch();
    const client = new BeaconClient({ apiKey: 'k', fetchImpl: mock.impl });
    client.capture(sampleEvent());
    await client.flush();
    expect(mock.calls[0]!.url).toBe(DEFAULT_INGEST_URL);
    await client.shutdown();
  });

  it('an empty ingestUrl also falls back to the hosted endpoint', async () => {
    const mock = makeMockFetch();
    const client = new BeaconClient({
      ingestUrl: '',
      apiKey: 'k',
      fetchImpl: mock.impl,
    });
    client.capture(sampleEvent());
    await client.flush();
    expect(mock.calls[0]!.url).toBe(DEFAULT_INGEST_URL);
    await client.shutdown();
  });
});
