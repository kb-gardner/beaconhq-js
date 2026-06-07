// Unit + integration tests for best-effort validation-error capture.
//
// Unit: the extractors normalize Zod / class-validator / Fastify-AJV shapes into
// the stored {field, message, type?} contract, cap the count, and fail-open
// (return undefined) on unrecognized input.
//
// Integration: drive a real Zod parse through a Hono handler, a Nest-shaped
// BadRequestException through the interceptor, and a real Fastify schema 400, and
// assert the captured event carries validation_errors.
import { z } from 'zod';
import { Hono } from 'hono';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeaconClient } from '../src/client.js';
import { beaconHono } from '../src/hono.js';
import { fastifyBeacon } from '../src/fastify.js';
import { BeaconInterceptor } from '../src/nestjs.js';
import {
  fromZodError,
  fromNestException,
  fromFastifyError,
  MAX_VALIDATION_ERRORS,
} from '../src/validation.js';
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

afterEach(() => vi.useRealTimers());

describe('fromZodError', () => {
  it('extracts loc path + message + code from ZodError issues', () => {
    const schema = z.object({
      currency: z.string(),
      amount: z.number().int(),
      items: z.array(z.object({ price: z.number() })),
    });
    const r = schema.safeParse({ amount: 1.5, items: [{ price: 'x' }] });
    expect(r.success).toBe(false);
    const out = fromZodError((r as { error: unknown }).error)!;
    const byField = Object.fromEntries(out.map((e) => [e.field, e]));
    // missing top-level field
    expect(byField['currency']?.message).toBeTruthy();
    expect(byField['currency']?.type).toBeTruthy();
    // nested path joined with '.'
    expect(byField['items.0.price']).toBeTruthy();
  });

  it('returns undefined for a non-Zod value (fail-open)', () => {
    expect(fromZodError(new Error('nope'))).toBeUndefined();
    expect(fromZodError(undefined)).toBeUndefined();
    expect(fromZodError({})).toBeUndefined();
  });
});

describe('fromNestException', () => {
  it('extracts class-validator messages from a 400 BadRequestException shape', () => {
    const exc = {
      getStatus: () => 400,
      getResponse: () => ({
        statusCode: 400,
        message: ['email must be an email', 'amount must be a number'],
        error: 'Bad Request',
      }),
    };
    const out = fromNestException(exc)!;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ field: 'email', message: 'email must be an email' });
    expect(out[1].field).toBe('amount');
  });

  it('ignores non-400 exceptions (e.g. 404/500)', () => {
    expect(fromNestException({ getStatus: () => 404, getResponse: () => ({ message: 'x' }) })).toBeUndefined();
    expect(fromNestException({ status: 500 })).toBeUndefined();
  });
});

describe('fromFastifyError', () => {
  it('extracts AJV validation entries (required + type) with context-prefixed fields', () => {
    const err = {
      validationContext: 'body',
      validation: [
        { instancePath: '', keyword: 'required', params: { missingProperty: 'currency' }, message: "must have required property 'currency'" },
        { instancePath: '/amount', keyword: 'type', message: 'must be integer' },
      ],
    };
    const out = fromFastifyError(err)!;
    expect(out[0]).toEqual({ field: 'body.currency', message: "must have required property 'currency'", type: 'required' });
    expect(out[1]).toEqual({ field: 'body.amount', message: 'must be integer', type: 'type' });
  });

  it('returns undefined when there is no .validation array', () => {
    expect(fromFastifyError(new Error('boom'))).toBeUndefined();
  });
});

describe('caps', () => {
  it('caps extracted errors at MAX_VALIDATION_ERRORS', () => {
    const big = z.object(
      Object.fromEntries(
        Array.from({ length: MAX_VALIDATION_ERRORS + 20 }, (_, i) => [`f${i}`, z.string()]),
      ),
    );
    const out = fromZodError((big.safeParse({}) as { error: unknown }).error)!;
    expect(out.length).toBe(MAX_VALIDATION_ERRORS);
  });
});

describe('Hono + Zod integration', () => {
  // Hono catches a thrown ZodError inside its dispatch chain (so `await next()`
  // resolves, not rejects — see hono.test.ts). The real Hono+Zod path therefore
  // returns a 400 RESPONSE; the integration point is stashing the failing result
  // on the context (the default `beaconValidationError` key), which the middleware
  // reads. This mirrors a `@hono/zod-validator` hook that responds 400.
  it('captures validation_errors from a context-stashed Zod result on a 400', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client));
    const schema = z.object({ currency: z.string() });
    app.post('/checkout', (c) => {
      const result = schema.safeParse({}); // missing currency
      if (!result.success) {
        c.set('beaconValidationError', result); // zValidator-style stash
        return c.json({ error: 'invalid_body' }, 400);
      }
      return c.json(result.data);
    });

    const res = await app.request('/checkout', { method: 'POST' });
    expect(res.status).toBe(400);

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(400);
    expect(ev.validation_errors).toBeTruthy();
    expect(ev.validation_errors![0].field).toBe('currency');
    await client.shutdown();
  });

  it('omits validation_errors (null) on a normal request', async () => {
    const { client, mock } = makeClient();
    const app = new Hono();
    app.use('*', beaconHono(client));
    app.get('/ok', (c) => c.text('ok'));
    await app.request('/ok');
    await client.flush();
    expect(mock.sentEvents[0]!.validation_errors).toBeNull();
    await client.shutdown();
  });
});

describe('NestJS interceptor + class-validator integration', () => {
  it('captures validation_errors from a thrown 400 BadRequestException', async () => {
    const { client, mock } = makeClient();
    const interceptor = new BeaconInterceptor(client);

    const req = { method: 'POST', url: '/checkout', route: { path: '/checkout' }, headers: {} };
    const res = { statusCode: 200 };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };
    // A class-validator-shaped BadRequestException.
    const exc = {
      getStatus: () => 400,
      message: 'Bad Request Exception',
      getResponse: () => ({ statusCode: 400, message: ['currency should not be empty'], error: 'Bad Request' }),
    };
    const handler = {
      handle: () => ({
        subscribe: (observer: { error?: (e: unknown) => void }) => {
          observer.error?.(exc);
          return { unsubscribe() {} };
        },
      }),
    };

    const out = interceptor.intercept(ctx as never, handler as never);
    out.subscribe({ error: () => {} });

    await client.flush();
    const ev = mock.sentEvents[0]!;
    expect(ev.status).toBe(400);
    expect(ev.validation_errors).toBeTruthy();
    expect(ev.validation_errors![0].field).toBe('currency');
    await client.shutdown();
  });
});

describe('Fastify schema-validation integration', () => {
  it('captures validation_errors from a real schema 400', async () => {
    const { client, mock } = makeClient();
    const app = Fastify();
    await app.register(fastifyBeacon, { client });
    app.post(
      '/checkout',
      {
        schema: {
          body: {
            type: 'object',
            required: ['currency'],
            properties: { currency: { type: 'string' }, amount: { type: 'integer' } },
          },
        },
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: { amount: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);

    await client.flush();
    const ev = mock.sentEvents.find((e) => e.route === '/checkout')!;
    expect(ev).toBeTruthy();
    expect(ev.validation_errors).toBeTruthy();
    // The missing 'currency' required prop should be among the captured fields.
    expect(ev.validation_errors!.some((v) => v.field.includes('currency'))).toBe(true);
    await app.close();
    await client.shutdown();
  });
});
