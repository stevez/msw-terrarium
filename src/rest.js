/**
 * MSW-compatible REST route helper.
 *
 * Turns a declarative `{ 'METHOD /path': handler }` route table into an
 * array of MSW request handlers, adding the boilerplate every consumer
 * would otherwise write per route:
 *
 *   1. resolve the request's world via `store.forRequest`
 *   2. check sidecar precedence (pinned responses, transient failures)
 *   3. parse the request body for POST/PUT/PATCH (JSON, best-effort)
 *   4. parse the query string into a plain object
 *   5. delegate to the consumer's handler with a rich context object
 *   6. shape the return value into an HTTP response
 *
 * ### Return values
 *
 * The consumer handler may return any of:
 *   - `undefined` — fall through to the next MSW handler in the chain
 *   - a raw `Response` / `HttpResponse` — passed through unchanged
 *     (including `HttpResponse.error()`, `passthrough()`, streams, etc.)
 *   - a plain `{ status?, body?, headers? }` object — shaped into a
 *     `HttpResponse.json` (or headerless `Response` when body is undefined)
 *
 * ### Sidecar keys
 *
 * The default key format is `"METHOD /pattern"` (the same string used as the
 * route table key). Composite keys — e.g. per-JSON-RPC-method pins in the
 * form `"POST /api/x create_chat"` — are supported via the `keyFor`
 * config. The default is fine for pure REST APIs; JSON-RPC / GraphQL
 * consumers override.
 *
 * ### Path syntax
 *
 * Everything MSW supports is available: `:param`, `:param?`, `*`, regex
 * suffixes. See MSW docs. Params come through as `params`.
 *
 * ### Escape hatch
 *
 * Anything the helper can't do (streaming, multipart, custom headers,
 * one-shot handlers) can still be written as a raw MSW handler and mixed
 * into the returned array by the consumer.
 */

import { http, HttpResponse } from 'msw';

// eslint-disable-next-line import-x/extensions
import { matchResponse, decrementFailure, matchStream, respondFrom } from './sidecars.js';
// eslint-disable-next-line import-x/extensions
import { streamResponse } from './stream.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * @typedef {object} HandlerContext
 * @property {import('msw').Request} request       Raw MSW Request (uncloned).
 * @property {string}   requestId                  MSW's unique per-request ID.
 * @property {object}   params                     Path parameters from `path-to-regexp`.
 * @property {object}   cookies                    Parsed cookies from MSW.
 * @property {object}   query                      Query string, parsed via URLSearchParams.
 * @property {unknown}  body                       Auto-parsed JSON for POST/PUT/PATCH; null otherwise.
 * @property {object}   world                      Bucket world resolved via `store.forRequest`.
 */

/**
 * @typedef {object} ShapeResult
 * @property {number}   [status=200]
 * @property {unknown}  [body]                     If undefined, response has no body.
 * @property {object}   [headers]
 */

/**
 * Consumer's route handler. Returns undefined to fall through, a Response
 * for full control, or a ShapeResult for the common case.
 * @typedef {(ctx: HandlerContext) => Promise<Response | ShapeResult | undefined> | Response | ShapeResult | undefined} RouteHandler
 */

/**
 * @typedef {object} CreateRestHandlersConfig
 * @property {import('./world.js').Store} store
 * @property {string}   [urlPrefix='']             Prepended to every route pattern.
 * @property {Record<string, RouteHandler>} routes Route table, keyed by "METHOD /pattern".
 * @property {(input: { method: string, pattern: string, request: Request, body: unknown }) => string} [keyFor]
 *   Optional: compute the sidecar key per request. Default: `"METHOD /pattern"`.
 *   Override for JSON-RPC / GraphQL to include the operation name.
 */

/**
 * Build MSW handlers from a REST route table.
 *
 * @param {CreateRestHandlersConfig} config
 * @returns {Array<import('msw').RequestHandler>}
 */
export function createRestHandlers({ store, urlPrefix = '', routes, keyFor } = {}) {
  if (!store || typeof store.forRequest !== 'function') {
    throw new TypeError('createRestHandlers: store is required');
  }
  if (!routes || typeof routes !== 'object') {
    throw new TypeError('createRestHandlers: routes must be an object of { "METHOD /path": handler }');
  }

  const defaultKeyFor = ({ method, pattern }) => `${method} ${pattern}`;
  const resolveKey = keyFor ?? defaultKeyFor;

  return Object.entries(routes).map(([routeKey, handler]) => {
    if (typeof handler !== 'function') {
      throw new TypeError(`createRestHandlers: handler for "${routeKey}" is not a function`);
    }
    const spaceIdx = routeKey.indexOf(' ');
    if (spaceIdx <= 0 || spaceIdx === routeKey.length - 1) {
      throw new SyntaxError(
        `createRestHandlers: route key "${routeKey}" must have the form "METHOD /pattern"`,
      );
    }
    const methodUpper = routeKey.slice(0, spaceIdx).toUpperCase();
    const pattern = routeKey.slice(spaceIdx + 1);
    const httpMethod = methodUpper.toLowerCase();
    const mswFn = http[httpMethod];
    if (typeof mswFn !== 'function') {
      throw new SyntaxError(
        `createRestHandlers: route key "${routeKey}" uses unknown HTTP method "${methodUpper}"`,
      );
    }

    return mswFn(
      urlPrefix + pattern,
      async ({ request, requestId, params, cookies }) => {
        const world = await store.forRequest(request);

        // Body auto-parse for write methods. Use `.clone()` so the consumer
        // can still call `request.json()` / `.arrayBuffer()` themselves.
        let body = null;
        if (WRITE_METHODS.has(request.method)) {
          try {
            body = await request.clone().json();
          } catch {
            // not JSON / empty / not readable — leave null
          }
        }

        // Sidecar precedence — key depends on user-supplied strategy.
        const key = resolveKey({ method: methodUpper, pattern, request, body });
        const pinned = matchResponse(world.responses, key);
        if (pinned) return respondFrom(pinned);
        const failing = decrementFailure(world.failures, key);
        if (failing) return respondFrom(failing);
        // Step [3] in the sidecar precedence — pinned streaming response.
        const streamed = matchStream(world.streams, key);
        if (streamed) return streamResponse(request, streamed);

        // Query string.
        const url = new URL(request.url);
        const query = Object.fromEntries(url.searchParams);

        // Delegate.
        const result = await handler({
          request,
          requestId,
          params,
          cookies,
          query,
          body,
          world,
        });

        // 1. Fallthrough — let MSW try the next handler.
        if (result === undefined) return undefined;

        // 2. Raw Response / HttpResponse — pass through.
        if (result instanceof Response) return result;

        // 3. ShapeResult — { status?, body?, headers? }.
        const { status = 200, body: resBody, headers } = result;
        return resBody === undefined
          ? new Response(null, { status, headers })
          : HttpResponse.json(resBody, { status, headers });
      },
    );
  });
}
