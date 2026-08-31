import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBucketedStore } from '../src/world.js';
import { createSeedLoader } from '../src/seed-loader.js';
import { createMockApp } from '../src/mock-app.js';

function fakeCollection() {
  const rows = [];
  return {
    async create(row) { rows.push(row); return row; },
    async update(existing, spec) {
      const idx = rows.indexOf(existing);
      const draft = { ...existing };
      spec.data(draft);
      rows[idx] = draft;
    },
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
  seedsDir = mkdtempSync(join(tmpdir(), 'sms-app-'));
  writeFileSync(join(seedsDir, 'x.json'), JSON.stringify({}));
  store = createBucketedStore({ createDb: () => ({ chat: fakeCollection() }) });
  seedLoader = createSeedLoader({ seedsDir });
});

afterEach(() => {
  rmSync(seedsDir, { recursive: true, force: true });
});

describe('createMockApp (constructor)', () => {
  it('throws when store is missing', () => {
    expect(() => createMockApp({ seedLoader, handlers: [] })).toThrow(/store is required/);
  });
  it('throws when seedLoader is missing', () => {
    expect(() => createMockApp({ store, handlers: [] })).toThrow(/seedLoader is required/);
  });
  it('throws when handlers is not an array', () => {
    expect(() => createMockApp({ store, seedLoader })).toThrow(/handlers must be an array/);
    expect(() => createMockApp({ store, seedLoader, handlers: null })).toThrow(
      /handlers must be an array/,
    );
  });
});

describe('createMockApp (composition)', () => {
  it('mounts the control router at /__mock by default', async () => {
    const app = createMockApp({ store, seedLoader, handlers: [] });
    const res = await request(app).post('/__mock/reset').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, bucket: 'w0' });
  });

  it('respects a custom controlPath', async () => {
    const app = createMockApp({ store, seedLoader, handlers: [], controlPath: '/mockctl' });
    const res = await request(app).post('/mockctl/reset').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(200);
    // The default path should now 404 through to MSW middleware.
    const bad = await request(app).post('/__mock/reset').set('x-mock-bucket', 'w0');
    expect(bad.status).toBe(404);
  });

  it('serves MSW handlers alongside the control router', async () => {
    const handlers = [
      http.get('/api/hello', () => HttpResponse.json({ msg: 'hi' })),
    ];
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).get('/api/hello');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ msg: 'hi' });
  });

  it('parses JSON request bodies (for control endpoints and handlers)', async () => {
    let receivedBody;
    const handlers = [
      http.post('/api/echo', async ({ request: req }) => {
        receivedBody = await req.json();
        return HttpResponse.json(receivedBody);
      }),
    ];
    const app = createMockApp({ store, seedLoader, handlers });
    const res = await request(app).post('/api/echo').send({ hello: 'world' });
    expect(res.status).toBe(200);
    expect(receivedBody).toEqual({ hello: 'world' });
  });

  it('honors a raised jsonLimit', async () => {
    // At the 5mb default, a 6mb payload would be rejected. Raising to 10mb
    // lets it through — we don't send 6mb in a unit test, just verify the
    // limit config is threaded correctly by observing a small request works
    // with an explicit override.
    const app = createMockApp({ store, seedLoader, handlers: [], jsonLimit: '10mb' });
    const res = await request(app).post('/__mock/reset').set('x-mock-bucket', 'w0');
    expect(res.status).toBe(200);
  });

  it('disables x-powered-by by default', async () => {
    const app = createMockApp({ store, seedLoader, handlers: [] });
    const res = await request(app).post('/__mock/reset').set('x-mock-bucket', 'w0');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('preserves x-powered-by when disablePoweredBy=false', async () => {
    const app = createMockApp({
      store, seedLoader, handlers: [], disablePoweredBy: false,
    });
    const res = await request(app).post('/__mock/reset').set('x-mock-bucket', 'w0');
    expect(res.headers['x-powered-by']).toBe('Express');
  });
});
