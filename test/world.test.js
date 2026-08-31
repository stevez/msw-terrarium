import { describe, it, expect, vi } from 'vitest';
import { createBucketedStore } from '../src/world.js';

/**
 * Minimal fake @msw/data-compatible Collection:
 * - stores rows in an array
 * - findFirst / findMany accept a query builder with `where(criteria)`
 * - create resolves to the row
 */
function fakeCollection() {
  const rows = [];
  return {
    rows,
    create(row) { rows.push(row); return Promise.resolve(row); },
    findFirst(qb) {
      const c = qb({ where: (criteria) => criteria }) ?? {};
      return rows.find((r) => Object.entries(c).every(([k, v]) => r[k] === v));
    },
    findMany(qb) {
      const c = qb({ where: (criteria) => criteria }) ?? {};
      return rows.filter((r) => Object.entries(c).every(([k, v]) => r[k] === v));
    },
  };
}

const createDb = () => ({ chat: fakeCollection() });

describe('createBucketedStore', () => {
  it('throws if createDb is missing', () => {
    expect(() => createBucketedStore({})).toThrow(/createDb must be a function/);
  });

  it('resolves the default bucket when no header or cookie is present', () => {
    const store = createBucketedStore({ createDb });
    expect(store.resolveBucketId({ headers: {} })).toBe('default');
  });

  it('resolves bucket from x-mock-bucket header (case: plain object)', () => {
    const store = createBucketedStore({ createDb });
    expect(store.resolveBucketId({ headers: { 'x-mock-bucket': 'w3' } })).toBe('w3');
  });

  it('resolves bucket from Headers-like get() interface', () => {
    const store = createBucketedStore({ createDb });
    const headers = new Map([['x-mock-bucket', 'w7']]);
    expect(store.resolveBucketId({ headers })).toBe('w7');
  });

  it('falls back to bucket cookie when header is missing', () => {
    const store = createBucketedStore({ createDb });
    const req = { headers: { cookie: 'foo=1; mock-bucket=demo-a; bar=2' } };
    expect(store.resolveBucketId(req)).toBe('demo-a');
  });

  it('URL-decodes the cookie value', () => {
    const store = createBucketedStore({ createDb });
    const req = { headers: { cookie: 'mock-bucket=hello%20world' } };
    expect(store.resolveBucketId(req)).toBe('hello world');
  });

  it('respects custom bucketHeader / bucketCookie / defaultBucket', () => {
    const store = createBucketedStore({
      createDb,
      bucketHeader: 'x-tenant',
      bucketCookie: 'tenant',
      defaultBucket: 'fallback',
    });
    expect(store.resolveBucketId({ headers: {} })).toBe('fallback');
    expect(store.resolveBucketId({ headers: { 'x-tenant': 't1' } })).toBe('t1');
    expect(store.resolveBucketId({ headers: { cookie: 'tenant=t2' } })).toBe('t2');
  });

  it('creates and caches a fresh world per bucket on first access', async () => {
    const store = createBucketedStore({ createDb });
    const w1 = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    const w1Again = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    const w2 = await store.forRequest({ headers: { 'x-mock-bucket': 'w1' } });
    expect(w1).toBe(w1Again); // same bucket → same world
    expect(w1).not.toBe(w2);  // different bucket → different world
  });

  it('newly created world has empty sidecars and meta defaults', async () => {
    const store = createBucketedStore({ createDb });
    const w = await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    expect(w.responses).toEqual({});
    expect(w.failures).toEqual({});
    expect(w.streams).toEqual({});
    expect(w.meta).toEqual({ delayMs: 0, errorRate: 0 });
    expect(w.db.chat).toBeDefined();
  });

  it('awaits seedBaseline exactly once even under concurrent access', async () => {
    let calls = 0;
    let resolveSeed;
    const seedBaseline = vi.fn(() => {
      calls += 1;
      return new Promise((r) => { resolveSeed = r; });
    });
    const store = createBucketedStore({ createDb, seedBaseline });

    const req = { headers: { 'x-mock-bucket': 'w0' } };
    const p1 = store.forRequest(req);
    const p2 = store.forRequest(req);
    resolveSeed();
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(seedBaseline).toHaveBeenCalledOnce();
  });

  it('reset(bucketId) drops the world so next access re-inits', async () => {
    const store = createBucketedStore({ createDb });
    const req = { headers: { 'x-mock-bucket': 'w0' } };
    const before = await store.forRequest(req);
    store.reset('w0');
    const after = await store.forRequest(req);
    expect(after).not.toBe(before);
  });

  it('resetAll wipes every bucket', async () => {
    const store = createBucketedStore({ createDb });
    await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    await store.forRequest({ headers: { 'x-mock-bucket': 'w1' } });
    expect(store.list()).toHaveLength(2);
    store.resetAll();
    expect(store.list()).toEqual([]);
  });

  it('list returns active bucket IDs', async () => {
    const store = createBucketedStore({ createDb });
    await store.forRequest({ headers: { 'x-mock-bucket': 'w0' } });
    await store.forRequest({ headers: { 'x-mock-bucket': 'demo-a' } });
    expect(store.list().sort()).toEqual(['demo-a', 'w0']);
  });

  it('exposes bucketHeader/bucketCookie/defaultBucket on the store', () => {
    const store = createBucketedStore({ createDb });
    expect(store.bucketHeader).toBe('x-mock-bucket');
    expect(store.bucketCookie).toBe('mock-bucket');
    expect(store.defaultBucket).toBe('default');
  });
});
