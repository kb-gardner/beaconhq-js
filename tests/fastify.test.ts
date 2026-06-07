// Fastify plugin smoke tests.
//
// Drive real requests through a Fastify instance and assert the captured event
// carries the low-cardinality route TEMPLATE (request.routeOptions.url, not the
// concrete path), the status, a non-negative duration, and the resolved consumer.
// Also covers the not-found fallback, the 5xx error path, and the invariant that
// telemetry never breaks the request path.
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { fastifyBeacon } from '../src/fastify.js';
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

describe('fastifyBeacon', () => {
  it('captures the route template, not the concrete path', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, {
      client,
      consumerHeader: 'x-api-key',
    });
    app.get('/users/:id', (req, reply) => {
      reply.send((req.params as { id: string }).id);
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/users/123',
      headers: { 'x-api-key': 'acme' },
    });
    expect(res.statusCode).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/users/:id'); // template, not /users/123
    expect(ev.path).toBe('/users/123');
    expect(ev.method).toBe('GET');
    expect(ev.status).toBe(200);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ev.consumer).toBe('acme');
    await client.shutdown();
    await app.close();
  });

  it('captures the template for a prefixed (nested-register) route', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.register(
      (instance, _opts, done) => {
        instance.get('/users/:id', (req, reply) => {
          reply.send((req.params as { id: string }).id);
        });
        done();
      },
      { prefix: '/api' },
    );
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/users/123' });
    expect(res.statusCode).toBe(200);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/api/users/:id'); // full prefixed template
    expect(ev.path).toBe('/api/users/123');
    await client.shutdown();
    await app.close();
  });

  it('falls back to the concrete path when no route matched (404)', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.get('/users/:id', (_req, reply) => reply.send('ok'));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/nope/123' });
    expect(res.statusCode).toBe(404);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/nope/123'); // no template; concrete path
    expect(ev.path).toBe('/nope/123');
    expect(ev.status).toBe(404);
    await client.shutdown();
    await app.close();
  });

  it('records a 5xx status with an error message', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.get('/boom', (_req, reply) => {
      reply.status(500).send('nope');
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/boom' });
    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500);
    expect(ev.route).toBe('/boom');
    expect(ev.error).toBe('HTTP 500');
    await client.shutdown();
    await app.close();
  });

  it('strips the query string from the concrete path', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.get('/search', (_req, reply) => reply.send('ok'));
    await app.ready();

    await app.inject({ method: 'GET', url: '/search?q=hi&page=2' });
    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.path).toBe('/search');
    expect(ev.route).toBe('/search');
    await client.shutdown();
    await app.close();
  });

  it('omits the consumer when no consumerHeader is configured', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.get('/x', (_req, reply) => reply.send('ok'));
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-api-key': 'acme' },
    });
    await client.flush();
    expect(mock.sentEvents[0]!.consumer).toBeNull();
    await client.shutdown();
    await app.close();
  });

  it('never breaks the request even if capture() throws', async () => {
    const { client } = makeClient();
    vi.spyOn(client, 'capture').mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.get('/x', (_req, reply) => reply.send('still works'));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('still works');
    await client.shutdown();
    await app.close();
  });
});
