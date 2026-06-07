// Express middleware smoke tests.
//
// Mirrors sdk-py/tests/test_adapters.py: drive a real request through Express and
// assert the captured event carries the low-cardinality route TEMPLATE (not the
// concrete path), the status, a non-negative duration, and the resolved consumer.
// Also covers: route-less fallback to the concrete path, mounted-router templating,
// and the invariant that telemetry never breaks the request path.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { beaconExpress } from '../src/express.js';
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
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('beaconExpress', () => {
  it('captures the route template, not the concrete path', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client, { consumerHeader: 'x-api-key' }));
    app.get('/users/:id', (req, res) => res.send(req.params.id));

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

  it('captures the full template for a mounted router (baseUrl + route.path)', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    const router = express.Router();
    router.get('/users/:id', (req, res) => res.send(req.params.id));
    app.use('/api', router);

    const res = await request(app, '/api/users/123');
    expect(res.status).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/api/users/:id'); // full prefixed template
    expect(ev.path).toBe('/api/users/123');
    await client.shutdown();
  });

  it('falls back to the concrete path when no route matched (404)', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    app.get('/users/:id', (req, res) => res.send(req.params.id));

    const res = await request(app, '/nope/123');
    expect(res.status).toBe(404);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    // No route matched: fall back to the concrete path.
    expect(ev.route).toBe('/nope/123');
    expect(ev.path).toBe('/nope/123');
    expect(ev.status).toBe(404);
    await client.shutdown();
  });

  it('keeps the mount prefix on the fallback for an unmatched path under a mounted router (404)', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    const router = express.Router();
    router.get('/leads/:id', (req, res) => res.send(req.params.id));
    app.use('/api', router);

    // Unmatched under the mount: req.route is unset and req.path is mount-relative
    // ('/nope'), so the fallback must add req.baseUrl ('/api') back.
    const res = await request(app, '/api/nope');
    expect(res.status).toBe(404);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/api/nope'); // full path, NOT '/nope'
    expect(ev.path).toBe('/api/nope');
    expect(ev.status).toBe(404);
    await client.shutdown();
  });

  it('still templates a matched route under a mounted router (no regression)', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    const router = express.Router();
    router.get('/leads/:id', (req, res) => res.send(req.params.id));
    app.use('/api', router);

    const res = await request(app, '/api/leads/42');
    expect(res.status).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/api/leads/:id'); // template preserved
    expect(ev.path).toBe('/api/leads/42');
    await client.shutdown();
  });

  it('records a 5xx status with an error message', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    app.get('/boom', (_req, res) => res.status(500).send('nope'));

    await request(app, '/boom');
    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500);
    expect(ev.error).toBe('HTTP 500');
    await client.shutdown();
  });

  it('omits the consumer when no consumerHeader is configured', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(beaconExpress(client));
    app.get('/x', (_req, res) => res.send('ok'));

    await request(app, '/x', { 'x-api-key': 'acme' });
    await client.flush();
    expect(mock.sentEvents[0]!.consumer).toBeNull();
    await client.shutdown();
  });

  it('never breaks the request even if capture() throws', async () => {
    const { client } = makeClient();
    // Force capture() to throw to prove the middleware swallows it.
    vi.spyOn(client, 'capture').mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const app = express();
    app.use(beaconExpress(client));
    app.get('/x', (_req, res) => res.send('still works'));

    const res = await request(app, '/x');
    expect(res.status).toBe(200); // request completed despite the throw
    await client.shutdown();
  });
});
