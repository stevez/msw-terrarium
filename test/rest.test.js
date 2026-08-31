import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { HttpResponse, passthrough } from 'msw';
import { createBucketedStore } from '../src/world.js';
import { createMockApp } from '../src/mock-app.js';
import { createSeedLoader } from '../src/seed-loader.js';
import { createRestHandlers } from '../src/rest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal @msw/data-compatible fake collection. */
function fakeCollection(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  return {
    rows,
    async create(row) { rows.push({ ...row }); return row; },
    async delete(existing) { const i = rows.indexOf(existing); if (i >= 0) rows.splice(i, 1); },
    findFirst(qb) {
      const c = qb({ where: (criteria) => criteria });
      return rows.find((r) => Object.entries(c).every(([k, v]) => r[k] === v));
    },
    findMany(qb) {
      const c = qb({ where: (criteria) => criteria });
      return rows.filter((r) => Object.entries(c).every(([k, v]) => r[k] === v));
    },
  };
}

let store;
let seedLoader;
let seedsDir;

beforeEach(() => {
  store = createBucketedStore({
    createDb: () => ({ chat: fakeCollection([{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }]) }),
  });
  seedsDir = mkdtempSync(join(tmpdir(), 'sms-rest-'));
  seedLoader = createSeedLoader({ seedsDir });
});

afterEach(() => rmSync(seedsDir, { recursive: true, force: true }));

describe('createRestHandlers (validation)', () => {
  it('throws when store is missing', () => {
    expect(() => createRestHandlers({ routes: {} })).toThrow(/store is required/);
  });
  it('throws when routes is missing', () => {
    expect(() => createRestHandlers({ store })).toThrow(/routes must be an object/);
  });
  it('throws on malformed route key (no space)', () => {
    expect(() => createRestHandlers({ store, routes: { GET: () => {} } })).toThrow(
      /must have the form/,
    );
  });
  it('throws on unknown HTTP method', () => {
    expect(() =>
      createRestHandlers({ store, routes: { 'FROBNICATE /x': () => {} } }),
    ).toThrow(/unknown HTTP method "FROBNICATE"/);
  });
  it('throws when a handler is not a function', () => {
    expect(() =>
      createRestHandlers({ store, routes: { 'GET /x': 'not a function' } }),
    ).toThrow(/is not a function/);
  });
});

describe('createRestHandlers (basic routing)', () => {
  it('serves a simple GET with { body }', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/chats': ({ world }) => ({
          body: world.db.chat.findMany((q) => q.where({})),
        }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }]);
  });

  it('honors urlPrefix', async () => {
    const handlers = createRestHandlers({
      store,
      urlPrefix: '/v1',
      routes: {
        'GET /api/chats': () => ({ body: [] }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const withPrefix = await request(app).get('/v1/api/chats').set('x-mock-bucket', 'w0');
    expect(withPrefix.status).toBe(200);
    const withoutPrefix = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(withoutPrefix.status).toBe(404);
  });

  it('parses path params from :name syntax', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'DELETE /api/chats/:id': ({ world, params }) => {
          const target = world.db.chat.findFirst((q) => q.where({ id: params.id }));
          if (!target) return { status: 404 };
          world.db.chat.delete(target);
          return { status: 204 };
        },
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).delete('/api/chats/c1').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(204);
    const gone = await request(app)
      .delete('/api/chats/nope')
      .set('x-mock-bucket', 'w0');
    expect(gone.status).toBe(404);
  });

  it('parses query strings', async () => {
    let seenQuery;
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/search': ({ query }) => { seenQuery = query; return { body: {} }; },
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    await request(app).get('/api/search?q=hello&limit=10').set('x-mock-bucket', 'w0');
    expect(seenQuery).toEqual({ q: 'hello', limit: '10' });
  });
});

describe('createRestHandlers (body auto-parse)', () => {
  it('auto-parses JSON body for POST', async () => {
    let seenBody;
    const handlers = createRestHandlers({
      store,
      routes: {
        'POST /api/echo': ({ body }) => { seenBody = body; return { body }; },
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app)
      .post('/api/echo')
      .set('x-mock-bucket', 'w0')
      .send({ x: 1, y: 'z' });
    expect(res.status).toBe(200);
    expect(seenBody).toEqual({ x: 1, y: 'z' });
    expect(res.body).toEqual({ x: 1, y: 'z' });
  });

  it('does not auto-parse body for GET', async () => {
    let seenBody = 'not-changed';
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/x': ({ body }) => { seenBody = body; return { body: {} }; },
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    await request(app).get('/api/x').set('x-mock-bucket', 'w0');
    expect(seenBody).toBeNull();
  });

  it('leaves body as null when POST body is not JSON', async () => {
    let seenBody = 'not-changed';
    const handlers = createRestHandlers({
      store,
      routes: {
        'POST /api/upload': ({ body }) => { seenBody = body; return { body: {} }; },
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    // Send a non-JSON payload
    await request(app)
      .post('/api/upload')
      .set('x-mock-bucket', 'w0')
      .set('Content-Type', 'text/plain')
      .send('raw text');
    expect(seenBody).toBeNull();
  });
});

describe('createRestHandlers (response shapes)', () => {
  it('undefined return falls through (404 when nothing else matches)', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/x': () => undefined,
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/x').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(404);
  });

  it('raw Response is passed through', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/raw': () =>
          new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/raw').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(200);
    expect(res.text).toBe('plain text');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('HttpResponse.json is passed through', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/msw': () => HttpResponse.json({ from: 'msw' }, { status: 201 }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/msw').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ from: 'msw' });
  });

  it('ShapeResult with body → JSON response', async () => {
    const handlers = createRestHandlers({
      store,
      routes: {
        'GET /api/x': () => ({ status: 201, body: { ok: true }, headers: { 'x-t': 'v' } }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/x').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-t']).toBe('v');
  });

  it('ShapeResult with no body → headerless Response (used for 204 etc.)', async () => {
    const handlers = createRestHandlers({
      store,
      routes: { 'DELETE /api/x': () => ({ status: 204 }) },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).delete('/api/x').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});

describe('createRestHandlers (sidecar precedence)', () => {
  it('world.responses pin wins over the handler', async () => {
    // Prime the bucket world with a pinned response.
    await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } }); // instantiate
    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    w.responses['GET /api/chats'] = { status: 418, body: { pinned: true } };

    const handlers = createRestHandlers({
      store,
      routes: { 'GET /api/chats': () => ({ body: { pinned: false } }) },
    });
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ pinned: true });
  });

  it('world.failures fire once and then decrement', async () => {
    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    w.failures['GET /api/chats'] = { spec: { status: 500, body: { err: 'boom' } }, times: 1 };

    const handlers = createRestHandlers({
      store,
      routes: { 'GET /api/chats': () => ({ body: { ok: true } }) },
    });
    const app = createMockApp({ store, seedLoader, handlers });

    const first = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ err: 'boom' });

    const second = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true });
  });

  it('world.streams pin serves an SSE stream instead of the handler', async () => {
    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    w.streams['POST /chatloop'] = {
      chunks: [
        { event: 'text_delta', data: { message: 'hello ' } },
        { event: 'text_delta', data: { message: 'world' } },
      ],
      wrapAs: 'sse-event',
    };

    const handlers = createRestHandlers({
      store,
      routes: { 'POST /chatloop': () => ({ body: { should: 'not run' } }) },
    });
    const app = createMockApp({ store, seedLoader, handlers });

    const res = await request(app)
      .post('/chatloop')
      .set('x-mock-bucket', 'w0')
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    // supertest buffers the streamed body into res.text
    expect(res.text).toBe(
      'event: text_delta\ndata: {"message":"hello "}\n\nevent: text_delta\ndata: {"message":"world"}\n\n',
    );
  });

  it('world.responses wins over world.streams for the same key', async () => {
    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    w.responses['POST /chatloop'] = { status: 200, body: { pinned: true } };
    w.streams['POST /chatloop'] = {
      chunks: [{ event: 'text_delta', data: { message: 'x' } }],
      wrapAs: 'sse-event',
    };

    const handlers = createRestHandlers({
      store,
      routes: { 'POST /chatloop': () => ({ body: { fallback: true } }) },
    });
    const app = createMockApp({ store, seedLoader, handlers });

    const res = await request(app)
      .post('/chatloop')
      .set('x-mock-bucket', 'w0')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pinned: true });
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });

  it('custom keyFor supports JSON-RPC composite keys', async () => {
    const keyFor = ({ method, pattern, body }) =>
      body?.method ? `${method} ${pattern} ${body.method}` : `${method} ${pattern}`;

    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    // Pin only the create_chat sub-op.
    w.responses['POST /api/chats create_chat'] = {
      status: 200,
      body: { jsonrpc: '2.0', id: 'x', result: { pinned: true } },
    };

    const handlers = createRestHandlers({
      store,
      keyFor,
      routes: {
        'POST /api/chats': ({ body }) => ({
          body: { jsonrpc: '2.0', id: body.id, result: { pinned: false, method: body.method } },
        }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });

    const pinned = await request(app)
      .post('/api/chats')
      .set('x-mock-bucket', 'w0')
      .send({ jsonrpc: '2.0', id: '1', method: 'create_chat', params: {} });
    expect(pinned.body.result).toEqual({ pinned: true });

    const notPinned = await request(app)
      .post('/api/chats')
      .set('x-mock-bucket', 'w0')
      .send({ jsonrpc: '2.0', id: '2', method: 'list_chats' });
    expect(notPinned.body.result).toEqual({ pinned: false, method: 'list_chats' });
  });
});

describe('createRestHandlers (bucket isolation)', () => {
  it('two buckets see independent worlds', async () => {
    // Seed handler that mutates world state.
    const handlers = createRestHandlers({
      store,
      routes: {
        'POST /api/chats': async ({ world, body }) => {
          await world.db.chat.create({ id: body.id, title: body.title });
          return { status: 201, body: { id: body.id } };
        },
        'GET /api/chats': ({ world }) => ({
          body: world.db.chat.findMany((q) => q.where({})),
        }),
      },
    });
    const app = createMockApp({ store, seedLoader, handlers });

    // Bucket w0 creates a chat.
    await request(app)
      .post('/api/chats')
      .set('x-mock-bucket', 'w0')
      .send({ id: 'w0-chat', title: 'w0 chat' });

    // Bucket w1 lists — should not see w0's row.
    const w1Res = await request(app).get('/api/chats').set('x-mock-bucket', 'w1');
    expect(w1Res.body).not.toContainEqual({ id: 'w0-chat', title: 'w0 chat' });

    // Bucket w0 lists — sees its own row.
    const w0Res = await request(app).get('/api/chats').set('x-mock-bucket', 'w0');
    expect(w0Res.body).toContainEqual({ id: 'w0-chat', title: 'w0 chat' });
  });
});
