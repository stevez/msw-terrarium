import { describe, it, expect } from 'vitest';
import { streamResponse } from '../src/stream.js';

/**
 * Collect all UTF-8 text emitted by a streaming Response.
 */
async function collectText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function mkReq({ aborted = false } = {}) {
  // Minimal shape — streamResponse only touches `request.signal.aborted`.
  return { signal: { aborted } };
}

describe('streamResponse', () => {
  it('sets buffer-defeating headers by default', async () => {
    const res = streamResponse(mkReq(), { chunks: [] });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    // Drain the body so the stream closes cleanly.
    await collectText(res);
  });

  it('honors status and merges user headers over defaults', async () => {
    const res = streamResponse(mkReq(), {
      chunks: [],
      status: 500,
      headers: { 'X-Custom': 'yes', 'Cache-Control': 'no-store' },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('X-Custom')).toBe('yes');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await collectText(res);
  });

  it('sse-data wrapAs frames raw strings/objects as `data: <json>\\n\\n`', async () => {
    const res = streamResponse(mkReq(), {
      chunks: [{ delta: 'a' }, { delta: 'b' }],
      wrapAs: 'sse-data',
    });
    const text = await collectText(res);
    expect(text).toBe('data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\n');
  });

  it('sse-event wrapAs frames `{ event, data }` as named SSE blocks', async () => {
    const res = streamResponse(mkReq(), {
      chunks: [
        { event: 'text_delta', data: { message: 'hi' } },
        { event: 'done', data: { query: { ok: true } } },
      ],
      wrapAs: 'sse-event',
    });
    const text = await collectText(res);
    expect(text).toBe(
      'event: text_delta\ndata: {"message":"hi"}\n\nevent: done\ndata: {"query":{"ok":true}}\n\n',
    );
  });

  it('ndjson wrapAs frames chunks as `<json>\\n`', async () => {
    const res = streamResponse(mkReq(), {
      chunks: [{ a: 1 }, { a: 2 }],
      wrapAs: 'ndjson',
      contentType: 'application/x-ndjson',
    });
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
    const text = await collectText(res);
    expect(text).toBe('{"a":1}\n{"a":2}\n');
  });

  it('raw wrapAs emits chunks verbatim (strings passed through)', async () => {
    const res = streamResponse(mkReq(), {
      chunks: ['hello', ' ', 'world'],
      wrapAs: 'raw',
      contentType: 'text/plain',
    });
    const text = await collectText(res);
    expect(text).toBe('hello world');
  });

  it('emits a trailing finalMarker after all chunks', async () => {
    const res = streamResponse(mkReq(), {
      chunks: ['{"delta":"a"}'],
      wrapAs: 'sse-data',
      finalMarker: 'data: [DONE]\n\n',
    });
    const text = await collectText(res);
    expect(text).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
  });

  it('error sentinel { error: msg } emits an event: error frame and closes early', async () => {
    const res = streamResponse(mkReq(), {
      chunks: [
        { event: 'text_delta', data: { message: 'partial' } },
        { error: 'boom' },
        { event: 'text_delta', data: { message: 'never sent' } },
      ],
      wrapAs: 'sse-event',
    });
    const text = await collectText(res);
    expect(text).toBe(
      'event: text_delta\ndata: {"message":"partial"}\n\nevent: error\ndata: {"message":"boom"}\n\n',
    );
    expect(text).not.toContain('never sent');
  });

  it('closes immediately when request.signal.aborted is true', async () => {
    const res = streamResponse(mkReq({ aborted: true }), {
      chunks: [{ event: 'text_delta', data: { message: 'never' } }],
      wrapAs: 'sse-event',
    });
    const text = await collectText(res);
    expect(text).toBe('');
  });

  it('stops enqueuing when signal aborts mid-stream', async () => {
    const signal = { aborted: false };
    // Toggle aborted after the first chunk enqueue by using delayBetween +
    // a scheduled flip.
    const req = { signal };
    setTimeout(() => { signal.aborted = true; }, 10);
    const res = streamResponse(req, {
      chunks: [
        { event: 'text_delta', data: { message: 'first' } },
        { event: 'text_delta', data: { message: 'second' } },
        { event: 'text_delta', data: { message: 'third' } },
      ],
      wrapAs: 'sse-event',
      delayBetween: 40,
    });
    const text = await collectText(res);
    expect(text).toContain('first');
    // At least one of the trailing chunks must have been skipped.
    const secondSent = text.includes('second');
    const thirdSent = text.includes('third');
    expect(secondSent && thirdSent).toBe(false);
  });

  it('waits delayBetween ms between chunks', async () => {
    const start = Date.now();
    const res = streamResponse(mkReq(), {
      chunks: [{ event: 'a', data: {} }, { event: 'b', data: {} }, { event: 'c', data: {} }],
      wrapAs: 'sse-event',
      delayBetween: 25,
    });
    await collectText(res);
    const elapsed = Date.now() - start;
    // 3 chunks × 25ms = 75ms floor; allow slack for scheduling on Windows.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('accepts an empty chunks array and closes cleanly', async () => {
    const res = streamResponse(mkReq(), { chunks: [] });
    const text = await collectText(res);
    expect(text).toBe('');
  });

  it('accepts undefined spec (falls back to empty)', async () => {
    const res = streamResponse(mkReq(), undefined);
    expect(res.status).toBe(200);
    const text = await collectText(res);
    expect(text).toBe('');
  });
});
