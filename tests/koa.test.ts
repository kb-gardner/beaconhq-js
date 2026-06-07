// Koa middleware smoke tests.
//
// Drive real requests through a Koa app (with @koa/router) and assert the
// captured event carries the route TEMPLATE (ctx._matchedRoute), the concrete
// path, status, a non-negative duration, and the resolved consumer. Also covers
// the router-less fallback (concrete path only), the throwing-handler path
// (records status 500 + error, re-throws to the host), and the never-break
// invariant.
import Koa from 'koa';
import Router from '@koa/router';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { beaconKoa } from '../src/koa.js';
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

// Boot the app on an ephemeral port, fire one request, return the parsed response.
async function request(
  app: Koa,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('beaconKoa', () => {
  it('captures the route template via @koa/router, not the concrete path', async () => {
    const { client, mock } = makeClient();
    const app = new Koa();
    app.use(beaconKoa(client, { consumerHeader: 'x-api-key' }));
    const router = new Router();
    router.get('/users/:id', (ctx) => {
      ctx.body = ctx.params.id;
    });
    app.use(router.routes());

    const res = await request(app, '/users/123', { 'x-api-key': 'acme' });
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

  it('falls back to the concrete path when no router is present', async () => {
    const { client, mock } = makeClient();
    const app = new Koa();
    app.use(beaconKoa(client));
    app.use((ctx) => {
      ctx.body = 'ok';
    });

    const res = await request(app, '/users/123');
    expect(res.status).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    // No router → no _matchedRoute → concrete path is the best we have.
    expect(ev.route).toBe('/users/123');
    expect(ev.path).toBe('/users/123');
    await client.shutdown();
  });

  it('falls back to the concrete path on an unmatched route (404)', async () => {
    const { client, mock } = makeClient();
    const app = new Koa();
    app.use(beaconKoa(client));
    const router = new Router();
    router.get('/users/:id', (ctx) => {
      ctx.body = 'ok';
    });
    app.use(router.routes());

    const res = await request(app, '/nope/123');
    expect(res.status).toBe(404);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/nope/123');
    expect(ev.path).toBe('/nope/123');
    expect(ev.status).toBe(404);
    await client.shutdown();
  });

  it('records status 500 + error and re-throws when a handler throws', async () => {
    const { client, mock } = makeClient();
    const app = new Koa();
    // Silence Koa's default error logging for the thrown error.
    app.on('error', () => {});
    app.use(beaconKoa(client));
    const router = new Router();
    router.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.use(router.routes());

    const res = await request(app, '/boom');
    expect(res.status).toBe(500);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500);
    expect(ev.error).toBe('kaboom');
    expect(ev.route).toBe('/boom'); // matched route template survives the throw
    await client.shutdown();
  });

  it('omits the consumer when no consumerHeader is configured', async () => {
    const { client, mock } = makeClient();
    const app = new Koa();
    app.use(beaconKoa(client));
    const router = new Router();
    router.get('/x', (ctx) => {
      ctx.body = 'ok';
    });
    app.use(router.routes());

    await request(app, '/x', { 'x-api-key': 'acme' });
    await client.flush();
    expect(mock.sentEvents[0]!.consumer).toBeNull();
    await client.shutdown();
  });

  it('never breaks the request even if capture() throws', async () => {
    const { client } = makeClient();
    vi.spyOn(client, 'capture').mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const app = new Koa();
    app.use(beaconKoa(client));
    app.use((ctx) => {
      ctx.body = 'still works';
    });

    const res = await request(app, '/x');
    expect(res.status).toBe(200);
    expect(res.body).toBe('still works');
    await client.shutdown();
  });
});
