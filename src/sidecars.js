/**
 * Sidecar helpers used by handlers to check for pinned responses and
 * transient failures before running the normal DB path.
 *
 * Precedence in every handler:
 *   [1] world.__responses[key]  → pinned response wins
 *   [2] world.__failures[key]   → decrementing failure counter
 *   [3] world.__streams[key]    → streaming response
 *   [4] handler queries world.db
 *
 * Keys are of the form "METHOD PATH" or "METHOD PATH RPC_METHOD" (space-
 * separated). Handlers construct the key and pass it in.
 */

import { HttpResponse } from 'msw';

/** @typedef {import('./schema.js').ResponseSpec} ResponseSpec */

/**
 * Return a pinned response spec if the key matches, else null.
 * Keys are tried most-specific first: "M P RPC" before "M P".
 *
 * @param {Record<string, ResponseSpec>} responses
 * @param {string} key           "METHOD PATH RPC_METHOD"
 * @returns {ResponseSpec | null}
 */
export function matchResponse(responses, key) {
  if (!responses) return null;
  if (responses[key]) return responses[key];
  // Fallback: strip trailing RPC method and try again ("METHOD PATH").
  const lastSpace = key.lastIndexOf(' ');
  if (lastSpace > 0) {
    const withoutRpc = key.slice(0, lastSpace);
    if (responses[withoutRpc]) return responses[withoutRpc];
  }
  return null;
}

/**
 * Look up a failure counter; if it has remaining times, decrement it and
 * return the spec. Returns null when exhausted or absent.
 *
 * @param {Record<string, { spec: ResponseSpec, times: number }>} failures
 * @param {string} key
 * @returns {ResponseSpec | null}
 */
export function decrementFailure(failures, key) {
  if (!failures) return null;
  const entry = failures[key];
  if (!entry || entry.times <= 0) return null;
  entry.times -= 1;
  return entry.spec;
}

/**
 * Return a pinned stream spec if the key matches, else null. Mirrors
 * `matchResponse` — most-specific key first ("METHOD PATH RPC"), then the
 * RPC-less fallback ("METHOD PATH").
 *
 * @param {Record<string, import('./stream.js').StreamSpec>} streams
 * @param {string} key
 * @returns {import('./stream.js').StreamSpec | null}
 */
export function matchStream(streams, key) {
  if (!streams) return null;
  if (streams[key]) return streams[key];
  const lastSpace = key.lastIndexOf(' ');
  if (lastSpace > 0) {
    const withoutRpc = key.slice(0, lastSpace);
    if (streams[withoutRpc]) return streams[withoutRpc];
  }
  return null;
}

/**
 * Build an HttpResponse from a ResponseSpec, honoring status, headers,
 * delayMs, and body. Body is always JSON-serialized.
 *
 * @param {ResponseSpec} spec
 * @returns {Promise<Response>}
 */
export async function respondFrom(spec) {
  if (spec.delayMs) {
    await new Promise((r) => {
      setTimeout(r, spec.delayMs);
    });
  }
  return HttpResponse.json(spec.body, {
    status: spec.status ?? 200,
    headers: spec.headers,
  });
}
