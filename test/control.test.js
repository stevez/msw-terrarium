import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBucketedStore } from '../src/world.js';
import { createSeedLoader } from '../src/seed-loader.js';
import { createControlRouter } from '../src/control.js';

/** Minimal @msw/data-compatible fake — supports what control.js exercises. */
function fakeCollection() {
  const rows = [];
  return {
    async create(row) { rows.push({ ...row }); return row; },
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

let seedsDir;
let store;
let seedLoader;
let app;

beforeEach(() => {
  seedsDir = mkdtempSync(join(tmpdir(), 'sms-ctrl-'));
  writeFileSync(
    join(seedsDir, 'two-chats.json'),
    JSON.stringify({ chat: [{ id: 'c1', title: 'A' }, { id: 'c2', title: 'B' }] }),
  );
  writeFileSync(join(seedsDir, 'bad.json'), 'not valid json');

  store = createBucketedStore({ createDb: () => ({ chat: fakeCollection() }) });
  seedLoader = createSeedLoader({ seedsDir });

  app = express();
  app.use('/__mock', createControlRouter({ store, seedLoader }));
});

afterEach(() => {
  rmSync(seedsDir, { recursive: true, force: true });
});

describe('createControlRouter (constructor)', () => {
  it('throws when store is missing', () => {
    expect(() => createControlRouter({ seedLoader })).toThrow(/store is required/);
  });
  it('throws when seedLoader is missing', () => {
    expect(() => createControlRouter({ store })).toThrow(/seedLoader is required/);
  });
});

describe('POST /__mock/reset', () => {
  it('returns { ok: true, bucket } and drops that bucket', async () => {
    // Prime the bucket.
    await store.forRequest({ headers: { 'x-mock-bucket': 'w1' } });
    expect(store.list()).toContain('w1');

    const res = await request(app)
      .post('/__mock/reset')
      .set('x-mock-bucket', 'w1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, bucket: 'w1' });
    expect(store.list()).not.toContain('w1');
  });
});

describe('POST /__mock/load', () => {
  it('resets, then applies named seeds in order', async () => {
    const res = await request(app)
      .post('/__mock/load')
      .set('x-mock-bucket', 'w2')
      .send({ seeds: ['two-chats'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, bucket: 'w2', seeds: ['two-chats'] });

    const dump = await request(app).get('/__mock/state').set('x-mock-bucket', 'w2');
    expect(dump.body.db.chat).toHaveLength(2);
  });

  it('returns 400 when a seed cannot be parsed', async () => {
    const res = await request(app)
      .post('/__mock/load')
      .set('x-mock-bucket', 'w3')
      .send({ seeds: ['bad'] });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /__mock/patch', () => {
  it('applies inline seed on top of current state', async () => {
    await request(app)
      .post('/__mock/patch')
      .set('x-mock-bucket', 'w4')
      .send({ data: { chat: [{ id: 'c1', title: 'inline' }] } });

    const dump = await request(app).get('/__mock/state').set('x-mock-bucket', 'w4');
    expect(dump.body.db.chat).toEqual([{ id: 'c1', title: 'inline' }]);
  });

  it('returns 400 when data has an unknown key', async () => {
    const res = await request(app)
      .post('/__mock/patch')
      .set('x-mock-bucket', 'w5')
      .send({ data: { nonexistent: [] } });
    expect(res.status).toBe(400);
  });
});

describe('POST /__mock/fail', () => {
  it('arms a failure counter', async () => {
    const res = await request(app)
      .post('/__mock/fail')
      .set('x-mock-bucket', 'w6')
      .send({ key: 'GET /flaky', spec: { status: 500, body: { err: 'nope' } }, times: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dump = await request(app).get('/__mock/state').set('x-mock-bucket', 'w6');
    expect(dump.body.failures['GET /flaky']).toEqual({
      spec: { status: 500, body: { err: 'nope' } },
      times: 2,
    });
  });

  it('returns 400 when key or spec is missing', async () => {
    const res = await request(app)
      .post('/__mock/fail')
      .set('x-mock-bucket', 'w7')
      .send({ key: 'GET /x' });
    expect(res.status).toBe(400);
  });
});

describe('GET /__mock/state and /__mock/sessions', () => {
  it('/state dumps the bucket\'s world', async () => {
    await request(app)
      .post('/__mock/patch')
      .set('x-mock-bucket', 'w8')
      .send({ data: { chat: [{ id: 'c1', title: 'X' }] } });

    const res = await request(app).get('/__mock/state').set('x-mock-bucket', 'w8');
    expect(res.body.bucket).toBe('w8');
    expect(res.body.db.chat).toEqual([{ id: 'c1', title: 'X' }]);
    expect(res.body.responses).toEqual({});
    expect(res.body.failures).toEqual({});
    expect(res.body.meta).toEqual({ delayMs: 0, errorRate: 0 });
  });

  it('/sessions lists active bucket IDs', async () => {
    await request(app).post('/__mock/reset').set('x-mock-bucket', 'w-a');
    await store.forRequest({ headers: { 'x-mock-bucket': 'w-b' } });
    const res = await request(app).get('/__mock/sessions');
    expect(res.body.buckets).toEqual(expect.arrayContaining(['w-b']));
  });
});

describe('production guard', () => {
  it('returns 404 for all write endpoints when NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prodStore = createBucketedStore({ createDb: () => ({ chat: fakeCollection() }) });
      const prodApp = express();
      prodApp.use('/__mock', createControlRouter({ store: prodStore, seedLoader }));

      for (const url of ['/__mock/reset', '/__mock/load', '/__mock/patch', '/__mock/fail']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(prodApp).post(url).set('x-mock-bucket', 'w0').send({});
        expect(res.status, url).toBe(404);
      }
      const stateRes = await request(prodApp).get('/__mock/state');
      expect(stateRes.status).toBe(404);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
