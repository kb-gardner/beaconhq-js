// Shared test helpers: a controllable mock `fetch` and a sample event factory.
//
// The mock fetch records every call (url, method, headers, parsed JSON body) and
// returns a programmable Response. This mirrors sdk-py's MockTransport: tests set
// the next result (or an error to throw) and inspect what was "sent".
import { vi } from 'vitest';
import type { BeaconEvent } from '../src/client.js';

export interface SentCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { events: BeaconEvent[] };
}

export interface MockFetch {
  /** The vitest mock; pass as `fetchImpl`. */
  impl: typeof fetch;
  /** Every fetch invocation, decoded. */
  calls: SentCall[];
  /** Flat list of every event across all batches that were sent. */
  sentEvents: BeaconEvent[];
  /** Each batch (one entry per fetch call) of events. */
  batches: BeaconEvent[][];
  /** Set the status of the next response (default 200/ok). */
  setNextStatus: (status: number) => void;
  /** Make the next fetch reject with this error (simulates a network failure). */
  setNextError: (err: unknown) => void;
}

export function makeMockFetch(): MockFetch {
  let nextStatus = 200;
  let nextError: unknown = null;

  const calls: SentCall[] = [];
  const batches: BeaconEvent[][] = [];
  const sentEvents: BeaconEvent[] = [];

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (nextError !== null) {
      const err = nextError;
      nextError = null;
      throw err;
    }
    const status = nextStatus;
    nextStatus = 200; // reset to OK after each call unless re-set

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsed = JSON.parse((init?.body as string) ?? '{}') as {
      events: BeaconEvent[];
    };

    calls.push({
      url: String(url),
      method: String(init?.method),
      headers,
      body: parsed,
    });
    // Only count toward "sent" when the server actually accepts the batch.
    if (status >= 200 && status < 300) {
      batches.push(parsed.events);
      for (const e of parsed.events) sentEvents.push(e);
    }

    return new Response(JSON.stringify({ accepted: parsed.events.length }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    impl,
    calls,
    sentEvents,
    batches,
    setNextStatus: (s: number) => {
      nextStatus = s;
    },
    setNextError: (e: unknown) => {
      nextError = e;
    },
  };
}

export function sampleEvent(overrides: Partial<BeaconEvent> = {}): BeaconEvent {
  return {
    ts: '2026-06-03T12:00:00.000+00:00',
    method: 'GET',
    route: '/users/:id',
    path: '/users/123',
    status: 200,
    duration_ms: 42,
    consumer: 'acme',
    error: null,
    ...overrides,
  };
}

// ISO 8601 with an explicit offset (or Z) — what the ingest server's
// z.string().datetime({ offset: true }) accepts.
export const ISO_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/;

// The exact set of keys the ingest server validates per event.
export const EXPECTED_KEYS = [
  'ts',
  'method',
  'route',
  'path',
  'status',
  'duration_ms',
  'consumer',
  'error',
].sort();
