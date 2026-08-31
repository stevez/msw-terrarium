import { describe, it, expect, vi } from 'vitest';
import { matchResponse, decrementFailure, matchStream, respondFrom } from '../src/sidecars.js';

describe('matchResponse', () => {
  it('returns null when responses is null/undefined', () => {
    expect(matchResponse(null, 'GET /x')).toBeNull();
    expect(matchResponse(undefined, 'GET /x')).toBeNull();
  });

  it('returns null when no key matches', () => {
    expect(matchResponse({ 'GET /a': { body: {} } }, 'GET /b')).toBeNull();
  });

  it('returns the exact-key match', () => {
    const spec = { body: { ok: true } };
    expect(matchResponse({ 'GET /x': spec }, 'GET /x')).toBe(spec);
  });

  it('falls back to METHOD PATH when METHOD PATH RPC is not pinned', () => {
    // JSON-RPC-style composite key ("POST /api/chats create_chat")
    const spec = { body: {} };
    const responses = { 'POST /api/chats': spec };
    expect(matchResponse(responses, 'POST /api/chats create_chat')).toBe(spec);
  });

  it('exact composite key wins over METHOD PATH fallback', () => {
    const composite = { body: 'composite' };
    const generic = { body: 'generic' };
    const responses = {
      'POST /api/chats': generic,
      'POST /api/chats create_chat': composite,
    };
    expect(matchResponse(responses, 'POST /api/chats create_chat')).toBe(composite);
  });

  it('does not fall back for keys without a space', () => {
    // A single-token key has no "RPC" suffix to strip.
    expect(matchResponse({ x: { body: {} } }, 'y')).toBeNull();
  });
});

describe('decrementFailure', () => {
  it('returns null when failures is null/undefined', () => {
    expect(decrementFailure(null, 'GET /x')).toBeNull();
  });

  it('returns null when key is not armed', () => {
    expect(decrementFailure({}, 'GET /x')).toBeNull();
  });

  it('returns the spec and decrements the counter on hit', () => {
    const spec = { status: 500, body: { error: 'oops' } };
    const failures = { 'GET /x': { spec, times: 2 } };
    expect(decrementFailure(failures, 'GET /x')).toBe(spec);
    expect(failures['GET /x'].times).toBe(1);
    expect(decrementFailure(failures, 'GET /x')).toBe(spec);
    expect(failures['GET /x'].times).toBe(0);
    expect(decrementFailure(failures, 'GET /x')).toBeNull();
  });

  it('returns null when times is already <= 0', () => {
    const failures = { 'GET /x': { spec: { body: {} }, times: 0 } };
    expect(decrementFailure(failures, 'GET /x')).toBeNull();
  });
});

describe('matchStream', () => {
  it('returns null when streams is null/undefined', () => {
    expect(matchStream(null, 'POST /chatloop')).toBeNull();
    expect(matchStream(undefined, 'POST /chatloop')).toBeNull();
  });

  it('returns null when no key matches', () => {
    expect(matchStream({ 'POST /a': { chunks: [] } }, 'POST /b')).toBeNull();
  });

  it('returns the exact-key match', () => {
    const spec = { chunks: ['x'] };
    expect(matchStream({ 'POST /chatloop': spec }, 'POST /chatloop')).toBe(spec);
  });

  it('falls back to METHOD PATH when METHOD PATH RPC is not pinned', () => {
    const spec = { chunks: ['x'] };
    const streams = { 'POST /api/chats': spec };
    expect(matchStream(streams, 'POST /api/chats create_chat')).toBe(spec);
  });

  it('exact composite key wins over METHOD PATH fallback', () => {
    const composite = { chunks: ['composite'] };
    const generic = { chunks: ['generic'] };
    const streams = {
      'POST /api/chats': generic,
      'POST /api/chats create_chat': composite,
    };
    expect(matchStream(streams, 'POST /api/chats create_chat')).toBe(composite);
  });
});

describe('respondFrom', () => {
  it('returns a JSON response with the body', async () => {
    const res = await respondFrom({ body: { hello: 'world' } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hello: 'world' });
  });

  it('honors status and headers', async () => {
    const res = await respondFrom({
      status: 418,
      headers: { 'x-test': 'hi' },
      body: {},
    });
    expect(res.status).toBe(418);
    expect(res.headers.get('x-test')).toBe('hi');
  });

  it('waits for delayMs before responding', async () => {
    vi.useFakeTimers();
    const p = respondFrom({ body: {}, delayMs: 100 });
    // Nothing settles yet — advance timers.
    let settled = false;
    p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
