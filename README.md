# msw-terrarium

Bucket-scoped, isolated stateful mock server for parallel Playwright tests. Built on [MSW](https://mswjs.io) and [@msw/data](https://github.com/mswjs/data).

> **Status:** alpha (v0.1.0). APIs may change before v1.0.

## What this solves

Playwright tests running in parallel typically use MSW handlers that return **canned responses**. That's fine for simple assertions ("the UI shows this JSON"), but breaks the moment tests exercise **round-trip behavior**:

- Create a chat → verify it appears in the chat list
- Delete a message → verify it disappears after refresh
- Upload a file → verify it appears in the file list, then delete it

The problem: a stateless mock always returns `list_chats: []` regardless of whether you called `create_chat` a moment ago. Every "state-aware" spec has to work around this — patching per-test overrides, chaining together fake responses, using awkward `.first()` assertions. Tests get brittle and noisy.

**This library gives you a real in-memory backend per Playwright worker.** Handlers query real data (via `@msw/data` collections), mutations persist within the test, and every test starts with a clean slate. No cross-test leakage. No per-test override plumbing.

```js
test('user can delete a chat', async ({ page, given }) => {
  await given.load('two-chats-seeded');       // seed 2 chats into this worker's bucket

  await page.goto('/chats');
  await expect(page.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(page.getByRole('listitem')).toHaveCount(1); // real state change
});
```

Isolation between parallel workers is done via an `x-mock-bucket: w0` HTTP header — each worker gets its own in-memory "world", and the mock server routes requests to the right one.

## Install

```bash
npm install msw-terrarium
```

Peer dependencies (install if you use the corresponding features):

- `@playwright/test` >= 1.40 (for the Playwright adapter)

## Quick start (Playwright)

Below is the full setup for a project that wants stateful mocks. The library is designed to compose from small primitives; the quick-start uses opinionated convenience helpers, but every layer is swappable.

### 1. Declare your domain schema

```js
// e2e/mocks/schema.js
import { z } from 'zod';
import { defineSchema } from 'msw-terrarium';

export const { createDb, seedBaseline } = defineSchema({
  chat: {
    schema: z.object({
      id: z.string(),
      title: z.string(),
      created_at: z.string().default(() => new Date().toISOString()),
    }),
    idPrefix: 'chat',                             // ids like 'chat-1', 'chat-2', …
    defaults: (n) => ({ title: `Chat ${n}` }),
  },

  message: {
    schema: z.object({
      id: z.string(),
      chat_id: z.string(),
      content: z.string(),
    }),
    idPrefix: 'msg',
  },

  // Optional: baseline data every fresh world starts with.
  baseline: async ({ db }) => {
    await db.chat.createNext({ title: 'Welcome' });
  },
});
```

### 2. Declare your API handlers

```js
// e2e/mocks/handlers.js
import { createRestHandlers } from 'msw-terrarium';

export function createHandlers({ store }) {
  return createRestHandlers({
    store,
    urlPrefix: process.env.BACKEND_API_BASE_URL ?? '',
    routes: {
      'GET /api/chats': ({ world }) => ({
        body: world.db.chat.findMany((q) => q.where({})),
      }),

      'POST /api/chats': async ({ world, body }) => {
        const chat = await world.db.chat.createNext(body);
        return { status: 201, body: chat };
      },

      'DELETE /api/chats/:id': ({ world, params }) => {
        const target = world.db.chat.findFirst((q) => q.where({ id: params.id }));
        if (!target) return { status: 404 };
        world.db.chat.delete(target);
        return { status: 204 };
      },

      'GET /api/chats/:chatId/messages': ({ world, params }) => ({
        body: world.db.message.findMany((q) => q.where({ chat_id: params.chatId })),
      }),
    },
  });
}
```

### 3. Wire the mock server

```js
// e2e/mocks/index.js
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createBucketedStore, createSeedLoader, createMockApp } from 'msw-terrarium';
import { createDb, seedBaseline } from './schema.js';
import { createHandlers } from './handlers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const store = createBucketedStore({ createDb, seedBaseline });
export const seedLoader = createSeedLoader({ seedsDir: resolve(HERE, 'seeds') });

export function buildMockServer() {
  return createMockApp({
    store,
    seedLoader,
    handlers: createHandlers({ store }),
  });
}
```

### 4. Boot the server

```js
// e2e/mocks/server.mjs
process.env.BACKEND_API_BASE_URL = '';  // handlers use bare paths internally

const { buildMockServer } = await import('./index.js');
const { startMockServer } = await import('msw-terrarium');

startMockServer(buildMockServer(), {
  port: 9090,
  name: 'mock server',
});
```

### 5. Wire the Playwright fixture

```js
// e2e/fixtures.js
import { test as base, expect } from '@playwright/test';
import { extendWithGiven } from 'msw-terrarium/playwright';

export const test = extendWithGiven(base, {
  mockUrl: 'http://localhost:9090',
  bucketHeader: 'x-mock-bucket',
});
export { expect };
```

### 6. Write BDD-style specs

```js
// e2e/chats.spec.js
import { test, expect } from './fixtures.js';

test('user can create and delete a chat', async ({ page, given }) => {
  // Given: a fresh bucket (auto-reset before every test) — start empty.
  await given.load('empty');

  // When: create via the UI.
  await page.goto('/chats');
  await page.getByRole('button', { name: 'New chat' }).click();

  // Then: it appears in the list.
  await expect(page.getByRole('listitem')).toHaveCount(1);

  // When: delete it.
  await page.getByRole('button', { name: 'Delete' }).click();

  // Then: it's gone (real state change through the mock server).
  await expect(page.getByRole('listitem')).toHaveCount(0);
});
```

### 7. Boot the mock server before Playwright runs

Add to your `package.json`:

```json
{
  "scripts": {
    "start:mock":   "node e2e/mocks/server.mjs",
    "test:e2e":     "start-server-and-test 'npm run start:mock' 9090 'playwright test'"
  }
}
```

That's the whole setup.

## API overview

### Client-side (`given.*`)

Every spec that uses the fixture gets a `given` API for driving the bucket:

| Call | Effect |
|---|---|
| `given.fresh()` | Reset this worker's bucket — the next request re-seeds baseline. Runs automatically before every test via `_autoFresh`. |
| `given.load(...seedNames)` | Reset, then apply the named seeds in order. Seeds are JSON files under `seedsDir`. |
| `given.patch({ chat: [...], responses: {...} })` | Upsert rows and/or sidecar overrides directly. |
| `given.patch({ streams: { 'POST /chatloop': { chunks, delayBetween, wrapAs } } })` | Pin a streaming response (SSE / NDJSON) for a route — see [Streaming responses](#streaming-responses). |
| `given.failNext(key, spec, times = 1)` | Arm a transient failure — the next `times` requests matching `key` return the failure spec. |
| `given.rpcResult(rpcMethod, result, urlPath)` | Ergonomic helper for JSON-RPC-shaped pins. |
| `given.rpcError(rpcMethod, code, msg, urlPath)` | Ergonomic helper for JSON-RPC-shaped errors. |

### Server-side

Composed from primitives (framework-agnostic) and helpers (opinionated glue):

**Primitives**
- `createBucketedStore({ createDb, seedBaseline?, bucketHeader?, bucketCookie?, defaultBucket? })` — the bucket resolver + world lazy-init.
- `createSeedLoader({ seedsDir })` — loads JSON seeds with path-traversal guards.
- `createControlRouter({ store, seedLoader })` — Express router for `/__mock/reset|load|patch|fail|state|sessions`.
- `matchResponse(responses, key)`, `matchStream(streams, key)`, `decrementFailure(failures, key)`, `respondFrom(spec)`, `streamResponse(request, spec)` — sidecar helpers. See [Streaming responses](#streaming-responses) for the streaming primitive.

**Framework helpers**
- `defineSchema({ collection: { schema, idPrefix?, idFrom?, defaults? }, baseline? })` — wraps `@msw/data` with counters + `createNext`. Returns `{ createDb, seedBaseline }`.
- `createMockApp({ store, seedLoader, handlers, jsonLimit?, controlPath? })` — composes Express + control router + MSW middleware.
- `startMockServer(app, { port, name?, keepAliveTimeout?, headersTimeout?, handleSignals? })` — listens, tunes keep-alive against undici's socket pool, and installs SIGTERM handlers.
- `createRestHandlers({ store, urlPrefix?, routes, keyFor? })` — declarative REST route table on top of MSW handlers. Auto-parses body, resolves world, checks sidecar precedence.
- `definePlaywrightMock({ base, port, schema, handlers, seedsDir, mockUrl, ... })` — one-call all-in-one convenience.

**Playwright adapter** (subpath: `msw-terrarium/playwright`)
- `extendWithGiven(base, { mockUrl, bucketHeader, beforePage? })` — extends a Playwright `test` object with `bucketId`, `page` (bucket header attached), `given`, and `_autoFresh` fixtures.

## How it works

```
┌───────────────────────────────────────────────────────────┐
│  Playwright workers (w0, w1, w2, ...)                     │
│  Each request tagged with `x-mock-bucket: w<workerIndex>` │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│  Mock server (single Express process, one port)           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  /__mock/* control endpoints (reset, load, ...)     │  │
│  │  MSW handlers via @mswjs/http-middleware            │  │
│  └─────────────────────────────────────────────────────┘  │
│  Every request → worldFor(req) → the right bucket's world │
└───────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│  In-memory worlds (Map<bucketId, World>)                  │
│  World: {                                                 │
│    db:        @msw/data collections (chat, message, ...)  │
│    responses: pinned response specs                       │
│    failures:  transient failure counters                  │
│    streams:   pinned streaming response specs (SSE / NDJSON) │
│    meta:      { delayMs, errorRate }                      │
│  }                                                        │
└───────────────────────────────────────────────────────────┘
```

- **Isolation is a property of unique bucket IDs**, not of code that runs. Workers can't collide because they never touch the same world.
- **Each test starts clean** via the `_autoFresh` auto-fixture (`POST /__mock/reset` before every test).
- **The mock server is dev-only** — control endpoints refuse to register when `NODE_ENV=production`.

## Streaming responses

Some endpoints stream tokens back over Server-Sent Events (SSE) or newline-delimited JSON (NDJSON) instead of returning a single JSON response. The `streams` sidecar handles these — step [3] in the precedence contract:

```
[1] world.responses[key] → pinned JSON response
[2] world.failures[key]  → decrementing failure counter
[3] world.streams[key]   → pinned streaming response  ← streams sidecar
[4] handler(world)       → normal DB path
```

### Pin a streaming response from a spec

```js
await given.patch({
  streams: {
    'POST /chatloop': {
      chunks: [
        { event: 'text_delta', data: { message: 'hello ' } },
        { event: 'text_delta', data: { message: 'world' } },
        { event: 'done',       data: { query: { ok: true } } },
      ],
      delayBetween: 0,      // ms between chunks; use nonzero to observe timing
      wrapAs: 'sse-event',  // 'sse-data' | 'sse-event' | 'ndjson' | 'raw'
    },
  },
});
```

The consumer then makes a normal request (`POST /chatloop`) and reads the `text/event-stream` response as it arrives. The pin lives on the current worker's world, so parallel tests never see each other's streams.

### Spec fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `chunks` | `Array<string \| object \| { error: string }>` | — | `{ error }` is a sentinel — emits a named `event: error` frame and closes the stream, so specs don't hand-roll error frames. |
| `delayBetween` | `number` | `0` | ms between chunks. Keep `0` for ordering tests; nonzero only when observing timing. |
| `wrapAs` | `'sse-data' \| 'sse-event' \| 'ndjson' \| 'raw'` | `'sse-data'` | Framing dialect. `'sse-event'` requires each chunk to be `{ event, data }`. |
| `contentType` | `string` | `'text/event-stream'` | Overridden e.g. `'application/x-ndjson'` for NDJSON streams. |
| `finalMarker` | `string` | — | Optional trailer, e.g. `'data: [DONE]\n\n'`. |
| `status` | `number` | `200` | Non-2xx streams are supported — useful for asserting error paths. |
| `headers` | `Record<string,string>` | — | Merged over the buffer-defeating defaults below. |

### Default response headers

Chosen to defeat intermediary buffering seen in real reverse-proxy setups. Override by passing `headers` in the spec.

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Cancel semantics

`request.signal.aborted` is checked between every chunk. Playwright cancel tests using `AbortController` (or any consumer that aborts the fetch) actually stop the stream mid-flight instead of running to completion.

### Precedence with `responses` and `failures`

A `responses` pin on the same route still wins over a `streams` pin — the JSON-first fallback path is preserved. Use this to keep a happy-path streaming default while overriding one specific test with a canned JSON response.

### Using the primitive directly

For handlers that need custom logic before streaming (e.g. inspect the request body, then choose which chunks to emit), skip the sidecar and call the primitive:

```js
import { streamResponse } from 'msw-terrarium';

http.post('/chatloop', ({ request }) => streamResponse(request, {
  chunks: [ /* … */ ],
  wrapAs: 'sse-event',
}));
```

## Development

```bash
git clone https://github.com/stevez/msw-terrarium
cd msw-terrarium
npm install
npm test              # run once
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

## License

MIT. See [LICENSE](LICENSE).
