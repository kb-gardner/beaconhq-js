// Unit tests for the opt-in request-inspection masking + bounding helpers.
//
// Privacy is the whole point of this feature, so these assert the hard rules:
//   - capture is OFF by default (no flags => disabled, no work)
//   - sensitive headers are redacted; allow-list overrides; case-insensitive
//   - sensitive JSON body fields are masked recursively (nested + arrays)
//   - bodies are truncated at the byte cap and flagged
//   - non-text/binary content types are skipped
//   - a custom masker runs last
import { describe, expect, it } from 'vitest';
import {
  resolveCaptureConfig,
  captureDisabled,
  maskHeaders,
  maskBody,
  isCapturableContentType,
  REDACTED,
} from '../src/capture.js';

describe('resolveCaptureConfig', () => {
  it('is OFF by default — no flag enabled', () => {
    const cfg = resolveCaptureConfig();
    expect(cfg.captureHeaders).toBe(false);
    expect(cfg.captureRequestBody).toBe(false);
    expect(cfg.captureResponseBody).toBe(false);
    expect(captureDisabled(cfg)).toBe(true);
  });

  it('masking is ON by default once capture is enabled', () => {
    const cfg = resolveCaptureConfig({ captureHeaders: true });
    expect(cfg.maskSensitive).toBe(true);
    expect(captureDisabled(cfg)).toBe(false);
  });
});

describe('maskHeaders', () => {
  const cfg = resolveCaptureConfig({ captureHeaders: true });

  it('redacts known sensitive headers (case-insensitive)', () => {
    const out = maskHeaders(
      {
        Authorization: 'Bearer secrettoken',
        Cookie: 'session=abc',
        'X-API-Key': 'k-123',
        'Content-Type': 'application/json',
        accept: 'text/html',
      },
      cfg,
    );
    expect(out.Authorization).toBe(REDACTED);
    expect(out.Cookie).toBe(REDACTED);
    expect(out['X-API-Key']).toBe(REDACTED);
    // Non-sensitive headers pass through unchanged.
    expect(out['Content-Type']).toBe('application/json');
    expect(out.accept).toBe('text/html');
  });

  it('honors an allow list (un-redacts an otherwise-sensitive header)', () => {
    const allowCfg = resolveCaptureConfig({
      captureHeaders: true,
      allowHeaders: ['x-api-key'],
    });
    const out = maskHeaders({ 'x-api-key': 'k-123', cookie: 'c' }, allowCfg);
    expect(out['x-api-key']).toBe('k-123'); // allow-listed
    expect(out.cookie).toBe(REDACTED); // still redacted
  });

  it('redacts extra deny-listed headers', () => {
    const denyCfg = resolveCaptureConfig({
      captureHeaders: true,
      denyHeaders: ['x-internal-token'],
    });
    const out = maskHeaders({ 'x-internal-token': 'nope' }, denyCfg);
    expect(out['x-internal-token']).toBe(REDACTED);
  });

  it('joins multi-value headers and reads a WHATWG Headers object', () => {
    const h = new Headers();
    h.append('set-cookie', 'a=1');
    h.append('accept', 'text/html');
    const out = maskHeaders(h, cfg);
    expect(out['set-cookie']).toBe(REDACTED);
    expect(out.accept).toBe('text/html');
  });
});

describe('maskBody', () => {
  const cfg = resolveCaptureConfig({ captureRequestBody: true });

  it('masks sensitive fields recursively in JSON (nested + arrays)', () => {
    const raw = JSON.stringify({
      username: 'alice',
      password: 'hunter2',
      nested: { api_key: 'k', token: 't', keep: 'me' },
      cards: [{ card: '4111111111111111', cvv: '123' }],
    });
    const out = maskBody(raw, 'application/json', cfg, 'request');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.body);
    expect(parsed.username).toBe('alice'); // not sensitive
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.nested.api_key).toBe(REDACTED);
    expect(parsed.nested.token).toBe(REDACTED);
    expect(parsed.nested.keep).toBe('me');
    expect(parsed.cards[0].card).toBe(REDACTED);
    expect(parsed.cards[0].cvv).toBe(REDACTED);
    expect(out!.truncated).toBe(false);
  });

  it('masks an already-parsed object body (express req.body)', () => {
    const out = maskBody({ password: 'x', ok: 1 }, 'application/json', cfg, 'request');
    const parsed = JSON.parse(out!.body);
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.ok).toBe(1);
  });

  it('truncates a body past the cap and flags it', () => {
    const small = resolveCaptureConfig({ captureRequestBody: true, maxBodyBytes: 16 });
    const out = maskBody('x'.repeat(100), 'text/plain', small, 'request');
    expect(out!.body.length).toBe(16);
    expect(out!.truncated).toBe(true);
  });

  it('skips binary / non-capturable content types', () => {
    expect(maskBody('\x00\x01', 'application/octet-stream', cfg, 'request')).toBeNull();
    expect(maskBody('GIF89a', 'image/gif', cfg, 'request')).toBeNull();
    expect(isCapturableContentType('application/json')).toBe(true);
    expect(isCapturableContentType('text/plain')).toBe(true);
    expect(isCapturableContentType('image/png')).toBe(false);
    expect(isCapturableContentType(undefined)).toBe(false);
  });

  it('keeps raw text when JSON is malformed (still bounded)', () => {
    const out = maskBody('{not valid json', 'application/json', cfg, 'request');
    expect(out!.body).toBe('{not valid json');
  });

  it('runs a custom bodyMasker last', () => {
    const masked = resolveCaptureConfig({
      captureRequestBody: true,
      bodyMasker: (b) => b.replace(/alice/g, '[name]'),
    });
    const out = maskBody(JSON.stringify({ user: 'alice' }), 'application/json', masked, 'request');
    expect(out!.body).toContain('[name]');
    expect(out!.body).not.toContain('alice');
  });

  it('does not mask when maskSensitive is false', () => {
    const nomask = resolveCaptureConfig({ captureRequestBody: true, maskSensitive: false });
    const out = maskBody(JSON.stringify({ password: 'p' }), 'application/json', nomask, 'request');
    expect(JSON.parse(out!.body).password).toBe('p');
  });
});
