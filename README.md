# beaconhq

Node/TypeScript client for [Beacon](https://beacon.skyware.dev) — buffers request
telemetry and ships it to the Beacon ingest API in batches, non-blocking, and never
throws into your application. Ships middleware for **Express, Fastify, Koa, NestJS,
and Hono** that auto-capture method, route template, status, and latency for every
request.

> Full docs: <https://beacon.skyware.dev/docs>

## Install

```bash
npm install beaconhq
```

## Quickstart

You only need a project ingest key — the client defaults to Beacon's hosted ingest
endpoint (`https://ingest.beacon.skyware.dev/v1/ingest`).

### Express

```ts
import express from 'express';
import { BeaconClient, beaconExpress } from 'beaconhq';

const app = express();

app.use(beaconExpress(new BeaconClient({ apiKey: process.env.BEACON_API_KEY })));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.listen(3000);
```

### Hono

```ts
import { Hono } from 'hono';
import { BeaconClient, beaconHono } from 'beaconhq';

const app = new Hono();

app.use('*', beaconHono(new BeaconClient({ apiKey: process.env.BEACON_API_KEY })));

app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));

export default app;
```

### Fastify

Registered as a plugin; it hooks `onResponse` so capture runs after the response is
sent. The client is passed as a plugin option:

```ts
import Fastify from 'fastify';
import { BeaconClient, fastifyBeacon } from 'beaconhq';

const app = Fastify();

await app.register(fastifyBeacon, {
  client: new BeaconClient({ apiKey: process.env.BEACON_API_KEY }),
});

app.get('/users/:id', (req, reply) => reply.send(req.params.id));

await app.listen({ port: 3000 });
```

The route template comes from `request.routeOptions.url` (e.g. `/users/:id`), and
duration from Fastify's own `reply.elapsedTime`.

### Koa

Middleware wraps `await next()` and records on completion. Register it **before**
your router so it sees the matched route. Route templating needs a router
(`@koa/router` / `koa-router`), which sets `ctx._matchedRoute`:

```ts
import Koa from 'koa';
import Router from '@koa/router';
import { BeaconClient, beaconKoa } from 'beaconhq';

const app = new Koa();
const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });

app.use(beaconKoa(beacon)); // before the router

const router = new Router();
router.get('/users/:id', (ctx) => { ctx.body = ctx.params.id; });
app.use(router.routes());

app.listen(3000);
```

> Without a router, Koa has no route metadata, so `route` falls back to the concrete
> request path (higher cardinality). Use `@koa/router`/`koa-router` for low-cardinality
> templates.

### NestJS

A Nest interceptor that works on both the Express and Fastify platforms. Register it
globally (or per-controller/handler with `@UseInterceptors`):

```ts
import { NestFactory } from '@nestjs/core';
import { BeaconClient, BeaconInterceptor } from 'beaconhq';
import { AppModule } from './app.module';

const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });

const app = await NestFactory.create(AppModule);
app.useGlobalInterceptors(new BeaconInterceptor(beacon));
await app.listen(3000);
```

The interceptor records on stream completion/error, derives the status from a thrown
`HttpException` (`getStatus()`), and re-throws so Nest's exception filters still run.

All adapters record `method`, the low-cardinality route **template**
(`/users/:id`, not the concrete `/users/123`), the concrete `path`, `status`, and
`duration_ms`. They never swallow your app's errors — a thrown error is recorded
and re-thrown.

Pass `{ consumerHeader: 'x-api-key-id' }` as the options argument to any adapter
to record the calling consumer from a request header:

```ts
app.use(beaconExpress(beacon, { consumerHeader: 'x-api-key-id' }));
// Fastify: await app.register(fastifyBeacon, { client: beacon, consumerHeader: 'x-api-key-id' });
// Koa:     app.use(beaconKoa(beacon, { consumerHeader: 'x-api-key-id' }));
// Nest:    new BeaconInterceptor(beacon, { consumerHeader: 'x-api-key-id' });
```

## Self-hosting / overriding the endpoint

Point at your own Beacon ingest by passing `ingestUrl`:

```ts
const beacon = new BeaconClient({
  apiKey: process.env.BEACON_API_KEY,
  ingestUrl: 'https://beacon.internal.example.com/v1/ingest',
});
```

## Manual capture

If you aren't using a middleware, enqueue events yourself:

```ts
import { BeaconClient } from 'beaconhq';

const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY });

beacon.capture({
  ts: new Date().toISOString(),
  method: 'GET',
  route: '/users/:id',
  path: '/users/123',
  status: 200,
  duration_ms: 42,
  consumer: 'acme',
  error: null,
});

// On graceful shutdown, flush remaining events:
process.on('SIGTERM', () => beacon.shutdown());
```

## Validation-error capture

The middleware best-effort captures **request-validation failures** so Beacon can
show, per endpoint, *which input fields fail validation, with what messages, how
often*. It's fail-open: capture never breaks or delays your app, and a request with
no detectable validation detail simply omits it.

- **Hono + Zod** — when a `ZodError` propagates to the middleware, or when a
  `@hono/zod-validator`-style hook stashes its failing result on the context under
  `beaconValidationError` (override via `beaconHono(client, { validationContextKey })`):

  ```ts
  app.post('/checkout', (c) => {
    const result = schema.safeParse(body);
    if (!result.success) {
      c.set('beaconValidationError', result); // picked up by beaconHono
      return c.json({ error: 'invalid_body' }, 400);
    }
    // ...
  });
  ```

- **NestJS + class-validator** — the default `ValidationPipe`'s
  `BadRequestException` (400, `message: string[]`) is captured automatically by
  `BeaconInterceptor`; no extra wiring.
- **Fastify schema validation** — the AJV `FST_ERR_VALIDATION` 400 is captured
  automatically by the `fastifyBeacon` plugin (via an `onError` hook).
- **Anywhere else** — extract structured errors yourself with the exported
  `fromZodError` / `fromZodResult` / `fromNestException` / `fromFastifyError`
  helpers and pass `validation_errors` to `beacon.capture(...)`.

Each entry is `{ field, message, type? }`; capture is capped (50 entries/event,
field/message length-bounded) to match the server.

## Request inspection (opt-in headers + body capture)

For deeper debugging you can capture the request/response **headers and bodies**
per request, surfaced in the Beacon request-log explorer. This is **OFF by default
and opt-in** — pass capture flags to any adapter:

```js
app.use(express.json()); // needed for request-body capture
app.use(
  beaconExpress(beacon, {
    captureHeaders: true,
    captureRequestBody: true,
    captureResponseBody: true,
  }),
);
```

**Privacy is built in.** When capture is enabled, **masking is ON by default**:

- Sensitive **headers** are redacted to `[REDACTED]` (`authorization`, `cookie`,
  `set-cookie`, `x-api-key`, …). Extend with `denyHeaders`, un-redact with
  `allowHeaders`.
- Sensitive **JSON body fields** are masked recursively (`password`, `token`,
  `secret`, `api_key`, `access_token`, `card`, `cvv`, `ssn`, …). Extend with
  `denyBodyFields`, or pass a custom `bodyMasker(body, kind) => string`.
- Bodies are **truncated** at `maxBodyBytes` (default 16KB) and flagged.
- Only `text/*` + JSON + form bodies are captured; **binary/streaming is skipped**.
- Set `maskSensitive: false` to disable masking (not recommended).

Capture is **fail-open and never disturbs your app's body handling**: request
bodies are read from the framework's already-parsed body (or a clone of the Web
Request), never the raw stream, so a raw-body route (e.g. a Stripe webhook) is
untouched. Response-body capture tees the response — the bytes your client receives
are unchanged.

| Capture option | Default | Notes |
|---|---|---|
| `captureHeaders` | `false` | Capture request + response headers (masked). |
| `captureRequestBody` | `false` | Capture the request body (from the parsed body). |
| `captureResponseBody` | `false` | Capture the response body. **Not supported by the Nest interceptor** — use the Express/Fastify adapter directly for response bodies. |
| `maskSensitive` | `true` | Master switch for header + body masking. |
| `denyHeaders` / `allowHeaders` | `[]` | Extend / override the header redaction list. |
| `denyBodyFields` | `[]` | Extend the masked JSON-field list. |
| `maxBodyBytes` | `16384` | Per-body truncation cap. |
| `bodyMasker` | — | `(body, 'request'\|'response') => string`, run last. |

Captured payloads are stored separately from metrics and pruned on a short
retention window (~15 days). Same flags exist on every adapter (Express, Hono,
Fastify, Koa; Nest captures headers + request body).

## Behavior

- Events are buffered and flushed every `flushIntervalMs` or when the buffer hits
  `batchSize`.
- The flush timer is `unref`'d so it never keeps your process alive on its own.
- On network failure or `5xx`, the batch is re-queued (bounded by `maxBufferSize`;
  oldest events drop past that). `4xx` responses are not retried (auth/validation).
- `capture()` and `flush()` never throw into your app; failures surface via `onError`.

## Configuration

`new BeaconClient(options)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — (required) | Per-project ingest key, sent as `Authorization: Bearer`. |
| `ingestUrl` | `string` | `https://ingest.beacon.skyware.dev/v1/ingest` | Full ingest endpoint. Override for self-hosted Beacon. |
| `flushIntervalMs` | `number` | `5000` | Flush cadence in ms. |
| `batchSize` | `number` | `100` | Buffered events that trigger an eager flush. |
| `maxBufferSize` | `number` | `10000` | Memory cap; oldest events drop past this. |
| `onError` | `(err) => void` | no-op | Observability hook; never required, never re-thrown. |
| `fetchImpl` | `typeof fetch` | global `fetch` | Inject a `fetch` implementation (tests). |

## API

- `new BeaconClient(options)` — see the table above.
- `client.capture(event: BeaconEvent)` — enqueue one event.
- `client.flush()` — force a flush (returns a Promise).
- `client.shutdown()` — flush and stop the timer.
- `beaconExpress(client, { consumerHeader? })` — Express middleware.
- `beaconHono(client, { consumerHeader? })` — Hono middleware.
- `fastifyBeacon` — Fastify plugin; register with `{ client, consumerHeader? }`.
- `beaconKoa(client, { consumerHeader? })` — Koa middleware.
- `BeaconInterceptor` — NestJS interceptor: `new BeaconInterceptor(client, { consumerHeader? })`
  (or `beaconNest(client, { consumerHeader? })`).
- `DEFAULT_INGEST_URL` — the hosted endpoint constant.

The framework packages (`express`, `fastify`, `koa` + `@koa/router`, `@nestjs/common`
+ `rxjs`, `hono`) are **optional peer dependencies** — install only the one(s) your
app uses; `beaconhq` does not pull them in.

`BeaconEvent` matches the ingest contract exactly:
`{ ts, method, route, path, status, duration_ms, consumer?, error? }`.

## License

MIT © Skyware LLC
