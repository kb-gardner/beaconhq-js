// Express opt-in request-inspection integration tests. Drives real requests and
// asserts: capture is absent by default; when enabled, headers + request body +
// response body are captured with sensitive values masked; the response delivered
// to the client is byte-for-byte unchanged (response-body buffering is a tee).
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

async function post(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

afterEach(() => vi.useRealTimers());

describe('beaconExpress capture', () => {
  it('captures nothing by default (opt-in OFF)', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(express.json());
    app.use(beaconExpress(client));
    app.post('/x', (_req, res) => res.json({ ok: true }));

    await post(app, '/x', { password: 'secret' });
    await client.flush();
    const ev = mock.sentEvents[0]!;
    // No capture field at all — default behavior is metadata only.
    expect(ev.capture ?? null).toBeNull();
    await client.shutdown();
  });

  it('captures masked headers + request/response bodies when enabled', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(express.json());
    app.use(
      beaconExpress(client, {
        captureHeaders: true,
        captureRequestBody: true,
        captureResponseBody: true,
      }),
    );
    app.post('/login', (req, res) => {
      res.json({ token: 'response-secret', user: req.body.username });
    });

    const out = await post(
      app,
      '/login',
      { username: 'alice', password: 'hunter2' },
      { authorization: 'Bearer xyz', 'x-api-key': 'k-1' },
    );
    expect(out.status).toBe(200);
    // The response to the client is unchanged (tee, not divert).
    expect(JSON.parse(out.text)).toEqual({ token: 'response-secret', user: 'alice' });

    await client.flush();
    const cap = mock.sentEvents[0]!.capture!;
    expect(cap).toBeTruthy();
    // Sensitive request headers redacted.
    expect(cap.request_headers!.authorization).toBe('[REDACTED]');
    expect(cap.request_headers!['x-api-key']).toBe('[REDACTED]');
    // Request body: password masked, username kept.
    const reqBody = JSON.parse(cap.request_body!);
    expect(reqBody.password).toBe('[REDACTED]');
    expect(reqBody.username).toBe('alice');
    // Response body: token masked.
    const resBody = JSON.parse(cap.response_body!);
    expect(resBody.token).toBe('[REDACTED]');
    expect(resBody.user).toBe('alice');
    await client.shutdown();
  });

  it('flags truncation when a body exceeds the cap', async () => {
    const { client, mock } = makeClient();
    const app = express();
    app.use(express.json());
    app.use(beaconExpress(client, { captureResponseBody: true, maxBodyBytes: 32 }));
    app.post('/big', (_req, res) => res.json({ data: 'z'.repeat(500) }));

    await post(app, '/big', {});
    await client.flush();
    const cap = mock.sentEvents[0]!.capture!;
    expect(cap.response_body_truncated).toBe(true);
    expect(cap.response_body!.length).toBeLessThanOrEqual(32);
    await client.shutdown();
  });
});
