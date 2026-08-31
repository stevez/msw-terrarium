/**
 * Streaming response primitive — step [3] in the sidecar precedence
 * documented in `sidecars.js`:
 *
 *   [1] world.responses[key] → pinned response
 *   [2] world.failures[key]  → decrementing failure
 *   [3] world.streams[key]   → streaming response  ← this file
 *   [4] handler(world)       → normal DB path
 *
 * Design constraints (mirrored from `respondFrom` / `matchResponse`):
 *   - Zero consumer knowledge — no SSE event names, no domain shapes.
 *   - Wire framing only: `sse-data`, `sse-event`, `ndjson`, `raw`.
 *   - Honor `request.signal.aborted` so Playwright cancel tests can stop
 *     the stream mid-flight.
 *   - Set the same buffer-defeating headers a real backend would
 *     (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`,
 *     `Connection: keep-alive`).
 *   - Error sentinel: a chunk shaped `{ error: 'msg' }` closes the stream
 *     after emitting a named `event: error` frame — no need to hand-roll
 *     error frames in specs.
 */

import { HttpResponse } from 'msw';

const encoder = new TextEncoder();

/**
 * Frame a chunk according to `wrapAs`.
 *
 * @param {unknown} chunk
 * @param {'sse-data'|'sse-event'|'ndjson'|'raw'} wrapAs
 * @returns {string}
 */
function frame(chunk, wrapAs) {
  if (wrapAs === 'sse-event') {
    // Named SSE event — chunk must be `{ event: string, data: unknown }`.
    return `event: ${chunk.event}\ndata: ${JSON.stringify(chunk.data)}\n\n`;
  }

  const serialized = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);

  if (wrapAs === 'sse-data') return `data: ${serialized}\n\n`;
  if (wrapAs === 'ndjson') return `${serialized}\n`;
  return serialized;
}

/**
 * @typedef {object} StreamSpec
 * @property {Array<string|object>} chunks
 *   Sequence of chunks to emit. String or object; object with
 *   `{ event, data }` is required when `wrapAs === 'sse-event'`. A chunk
 *   shaped `{ error: 'message' }` is the error sentinel — the library
 *   emits a named `event: error` frame and closes the stream.
 * @property {number} [delayBetween=0]
 *   ms between chunks. Keep 0 for ordering tests; use nonzero only when
 *   observing timing.
 * @property {'sse-data'|'sse-event'|'ndjson'|'raw'} [wrapAs='sse-data']
 * @property {string} [contentType='text/event-stream']
 * @property {string} [finalMarker]   e.g. 'data: [DONE]\n\n'
 * @property {number} [status=200]
 * @property {Record<string,string>} [headers]  merged over defaults
 */

/**
 * Build a streaming `Response` from a spec.
 *
 * @param {Request} request
 * @param {StreamSpec} spec
 * @returns {Response}
 */
export function streamResponse(request, spec) {
  const {
    chunks = [],
    delayBetween = 0,
    wrapAs = 'sse-data',
    contentType = 'text/event-stream',
    finalMarker,
    status = 200,
    headers,
  } = spec ?? {};

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          if (request.signal?.aborted) {
            controller.close();
            return;
          }

          // Error sentinel — emit an `event: error` frame and close.
          if (chunk && typeof chunk === 'object' && 'error' in chunk) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ message: chunk.error })}\n\n`,
              ),
            );
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(frame(chunk, wrapAs)));

          if (delayBetween) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => {
              setTimeout(r, delayBetween);
            });
          }
        }

        if (finalMarker) {
          controller.enqueue(encoder.encode(finalMarker));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new HttpResponse(stream, {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...headers,
    },
  });
}
