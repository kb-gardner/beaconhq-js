// Hono middleware smoke tests.
//
// Mirrors sdk-py/tests/test_adapters.py: drive a real request through a Hono app
// (via app.request) and assert the captured event carries the route TEMPLATE
// (c.req.routePath), the concrete path, status, a non-negative duration, and the
// resolved consumer. Also covers the not-found fallback, the throwing-handler path
// (records status 500 + error, re-throws to the host), and the never-break invariant.
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { beaconHono } from '../src/hono.js';
import { makeMockFetch } from './helpers.js';

function makeClient() {
  const mock = makeMockFetch();
  const client = new BeaconClient({
    ingestUrl: 'https://beacon.test/v1/ingest',
    apiKey: 'k',
    fetchImpl: mock.impl,
    flushIntervalMs: 999_000,
  });
  return { client, mock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('beaconHono', () => {
  it('captures the route template, not the concrete path', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client, { consumerHeader: 'x-api-key' }));
    app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

    const res = await app.request('/users/123', {
      headers: { 'x-api-key': 'acme' },
    });
    expect(res.status).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/users/:id'); // template, not /users/123
    expect(ev.path).toBe('/users/123');
    expect(ev.method).toBe('GET');
    expect(ev.status).toBe(200);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ev.consumer).toBe('acme');
    await client.shutdown();
  });

  it('captures the concrete path on a 404 (routePath is Hono\'s catch-all)', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client));
    app.get('/users/:id', (c) => c.text('ok'));

    const res = await app.request('/nope/123');
    expect(res.status).toBe(404);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    // For an unmatched request, Hono populates c.req.routePath with its internal
    // catch-all template ("/*"), so the middleware records that as the low-card
    // route. The concrete request path is always preserved verbatim.
    expect(ev.route).toBe('/*');
    expect(ev.path).toBe('/nope/123');
    expect(ev.status).toBe(404);
    await client.shutdown();
  });

  it('records status 500 with error=null when a handler throws (Hono catches before next() returns)', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });

    // Hono's default error handler converts the thrown error into a 500 Response
    // INSIDE the dispatch chain, so `await next()` resolves rather than rejecting.
    const res = await app.request('/boom');
    expect(res.status).toBe(500);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500); // status reflects the 500 response
    expect(ev.error).toBeNull(); // middleware's catch didn't fire (next resolved)
    await client.shutdown();
  });

  it('records the error and re-throws when next() actually rejects', async () => {
    // Drive the middleware's catch branch directly with a next() that rejects —
    // the path Hono takes when an error escapes the dispatch chain. The middleware
    // must record error + status 500 AND re-throw so the host can handle it.
    const { client, mock } = makeClient();
    const mw = beaconHono(client);
    const c = {
      req: { method: 'GET', path: '/x', routePath: '/x', header: () => undefined },
      res: { status: 200 },
    };
    const next = () => Promise.reject(new Error('escaped'));

    await expect(mw(c as never, next)).rejects.toThrow('escaped'); // re-thrown

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500);
    expect(ev.error).toBe('escaped');
    await client.shutdown();
  });

  it('omits the consumer when no consumerHeader is configured', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client));
    app.get('/x', (c) => c.text('ok'));

    await app.request('/x', { headers: { 'x-api-key': 'acme' } });
    await client.flush();
    expect(mock.sentEvents[0]!.consumer).toBeNull();
    await client.shutdown();
  });

  it('never breaks the request even if capture() throws', async () => {
    const { client } = makeClient();
    vi.spyOn(client, 'capture').mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const app = new Hono();
    app.use('*', beaconHono(client));
    app.get('/x', (c) => c.text('still works'));

    const res = await app.request('/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('still works');
    await client.shutdown();
  });
});
