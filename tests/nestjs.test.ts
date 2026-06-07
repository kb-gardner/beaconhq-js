// NestJS interceptor smoke tests.
//
// The interceptor implements Nest's `NestInterceptor` shape structurally and
// returns a pass-through Observable. We drive it with the real rxjs Observables
// Nest hands to interceptors (CallHandler.handle() returns an Observable) plus a
// mock ExecutionContext exposing the underlying HTTP request/response. We assert
// it records method/route/status/duration/consumer on completion, derives the
// status from a thrown HttpException, forwards values/errors to the subscriber,
// and never breaks the request path if capture() throws.
import { of, throwError, lastValueFrom, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { BeaconInterceptor, beaconNest } from '../src/nestjs.js';
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

// Build a Nest-style ExecutionContext over a plain Express-shaped request/response.
function makeContext(
  req: Record<string, unknown>,
  res: Record<string, unknown>,
) {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BeaconInterceptor', () => {
  it('captures method/route/status/consumer on a successful response', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client, {
      consumerHeader: 'x-api-key',
    });
    const ctx = makeContext(
      {
        method: 'GET',
        originalUrl: '/users/123?ref=x',
        route: { path: '/users/:id' },
        headers: { 'x-api-key': 'acme' },
      },
      { statusCode: 200 },
    );
    const handler = { handle: () => of({ id: '123' }) };

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual({ id: '123' }); // value forwarded to subscriber

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.method).toBe('GET');
    expect(ev.route).toBe('/users/:id'); // template, not the concrete path
    expect(ev.path).toBe('/users/123'); // query stripped
    expect(ev.status).toBe(200);
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ev.consumer).toBe('acme');
    expect(ev.error).toBeNull();
    await client.shutdown();
  });

  it('prefixes the mounted-router baseUrl onto the Express route template', async () => {
    const { client, mock } = makeClient();
    const interceptor = beaconNest(client);
    const ctx = makeContext(
      {
        method: 'POST',
        originalUrl: '/api/users/9',
        baseUrl: '/api',
        route: { path: '/users/:id' },
      },
      { statusCode: 201 },
    );

    await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of('created') }),
    );
    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.route).toBe('/api/users/:id');
    expect(ev.path).toBe('/api/users/9');
    expect(ev.status).toBe(201);
    await client.shutdown();
  });

  it('reads the route template from the Fastify platform shape', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client);
    const ctx = makeContext(
      {
        method: 'GET',
        url: '/things/42',
        routeOptions: { url: '/things/:id' },
      },
      { statusCode: 200 },
    );

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    await client.flush();
    expect(mock.sentEvents[0]!.route).toBe('/things/:id');
    await client.shutdown();
  });

  it('derives the status from a thrown HttpException and re-throws it', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client);
    const ctx = makeContext(
      { method: 'GET', originalUrl: '/forbidden', route: { path: '/forbidden' } },
      { statusCode: 200 }, // not yet written when the handler throws
    );
    // Mimic a Nest HttpException: carries getStatus().
    const httpException = Object.assign(new Error('Forbidden'), {
      getStatus: () => 403,
    });
    const handler = { handle: () => throwError(() => httpException) };

    await expect(
      firstValueFrom(interceptor.intercept(ctx, handler)),
    ).rejects.toThrow('Forbidden'); // error forwarded to subscriber

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(403);
    expect(ev.error).toBe('Forbidden');
    expect(ev.route).toBe('/forbidden');
    await client.shutdown();
  });

  it('defaults to status 500 on a thrown non-HttpException', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client);
    const ctx = makeContext(
      { method: 'GET', originalUrl: '/boom', route: { path: '/boom' } },
      { statusCode: 200 },
    );
    const handler = { handle: () => throwError(() => new Error('kaboom')) };

    await expect(
      firstValueFrom(interceptor.intercept(ctx, handler)),
    ).rejects.toThrow('kaboom');

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(500);
    expect(ev.error).toBe('kaboom');
    await client.shutdown();
  });

  it('omits the consumer when no consumerHeader is configured', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client);
    const ctx = makeContext(
      {
        method: 'GET',
        originalUrl: '/x',
        route: { path: '/x' },
        headers: { 'x-api-key': 'acme' },
      },
      { statusCode: 200 },
    );

    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    await client.flush();
    expect(mock.sentEvents[0]!.consumer).toBeNull();
    await client.shutdown();
  });

  it('never breaks the request even if capture() throws', async () => {
    const { client } = makeClient();
    vi.spyOn(client, 'capture').mockImplementation(() => {
      throw new Error('capture exploded');
    });
    const interceptor = new BeaconInterceptor(client);
    const ctx = makeContext(
      { method: 'GET', originalUrl: '/x', route: { path: '/x' } },
      { statusCode: 200 },
    );

    // The handler value must still flow through despite the capture throw.
    const result = await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => of('still works') }),
    );
    expect(result).toBe('still works');
    await client.shutdown();
  });
});
