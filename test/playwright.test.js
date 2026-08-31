import { describe, it, expect, vi } from 'vitest';
import { extendWithGiven } from '../src/playwright.js';

/**
 * Playwright's `test.extend({ fixtureName: async ({}, use) => ... })` returns a
 * new test object with those fixtures registered. For unit testing we don't
 * need to simulate the full runner — just enough that we can inspect what was
 * registered and drive the fixtures through their setup phase.
 */
function makeStubBase() {
  return {
    extend(fixtures) {
      return { fixtures };
    },
  };
}

/** Turn a Playwright-style fixture into a value by running it with a stub `use`. */
async function resolveFixture(entry, deps = {}, workerInfo = { workerIndex: 0 }) {
  const fn = Array.isArray(entry) ? entry[0] : entry;
  let value;
  await fn(deps, (v) => { value = v; return Promise.resolve(); }, workerInfo);
  return value;
}

describe('extendWithGiven', () => {
  it('registers bucketId, page, given, and _autoFresh fixtures', () => {
    const base = makeStubBase();
    const test = extendWithGiven(base, {
      mockUrl: 'http://localhost:9090',
      bucketHeader: 'x-mock-bucket',
    });
    expect(Object.keys(test.fixtures).sort()).toEqual(
      ['_autoFresh', 'bucketId', 'given', 'page'],
    );
  });

  it('bucketId is worker-scoped and derives from workerIndex', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://localhost:9090',
      bucketHeader: 'x-mock-bucket',
    });
    // Playwright fixture tuple: [fn, { scope: 'worker' }]
    expect(fixtures.bucketId[1]).toEqual({ scope: 'worker' });
    const bucketId = await resolveFixture(fixtures.bucketId, {}, { workerIndex: 3 });
    expect(bucketId).toBe('w3');
  });

  it('page fixture calls beforePage and attaches the bucket header', async () => {
    const base = makeStubBase();
    const beforePage = vi.fn(async () => {});
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://localhost:9090',
      bucketHeader: 'x-tenant',
      beforePage,
    });
    const setExtraHTTPHeaders = vi.fn();
    const page = { setExtraHTTPHeaders };
    const result = await resolveFixture(fixtures.page, { page, bucketId: 'w0' });
    expect(beforePage).toHaveBeenCalledWith(page);
    expect(setExtraHTTPHeaders).toHaveBeenCalledWith({ 'x-tenant': 'w0' });
    expect(result).toBe(page);
  });

  it('page fixture skips beforePage when not provided', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://localhost:9090',
      bucketHeader: 'x-mock-bucket',
    });
    const setExtraHTTPHeaders = vi.fn();
    const page = { setExtraHTTPHeaders };
    await resolveFixture(fixtures.page, { page, bucketId: 'w1' });
    expect(setExtraHTTPHeaders).toHaveBeenCalledWith({ 'x-mock-bucket': 'w1' });
  });

  it('given.fresh() posts to /__mock/reset with the bucket header', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const post = vi.fn().mockResolvedValue({});
    const request = { post };
    const given = await resolveFixture(fixtures.given, { request, bucketId: 'w0' });
    await given.fresh();
    expect(post).toHaveBeenCalledWith('http://mock/__mock/reset', {
      headers: { 'x-mock-bucket': 'w0' },
    });
  });

  it('given.load() posts to /__mock/load with seeds array', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const post = vi.fn().mockResolvedValue({});
    const given = await resolveFixture(fixtures.given, {
      request: { post },
      bucketId: 'w0',
    });
    await given.load('a', 'b');
    expect(post).toHaveBeenCalledWith('http://mock/__mock/load', {
      headers: { 'x-mock-bucket': 'w0' },
      data: { seeds: ['a', 'b'] },
    });
  });

  it('given.patch() posts inline data', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const post = vi.fn().mockResolvedValue({});
    const given = await resolveFixture(fixtures.given, {
      request: { post },
      bucketId: 'w0',
    });
    await given.patch({ chat: [{ id: 'c1' }] });
    expect(post).toHaveBeenCalledWith('http://mock/__mock/patch', {
      headers: { 'x-mock-bucket': 'w0' },
      data: { data: { chat: [{ id: 'c1' }] } },
    });
  });

  it('given.failNext() posts key/spec/times', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const post = vi.fn().mockResolvedValue({});
    const given = await resolveFixture(fixtures.given, {
      request: { post },
      bucketId: 'w0',
    });
    await given.failNext('GET /x', { status: 500, body: {} }, 3);
    expect(post).toHaveBeenCalledWith('http://mock/__mock/fail', {
      headers: { 'x-mock-bucket': 'w0' },
      data: { key: 'GET /x', spec: { status: 500, body: {} }, times: 3 },
    });
  });

  it('given.failNext() defaults times to 1', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const post = vi.fn().mockResolvedValue({});
    const given = await resolveFixture(fixtures.given, {
      request: { post },
      bucketId: 'w0',
    });
    await given.failNext('GET /x', { status: 500 });
    expect(post.mock.calls[0][1].data.times).toBe(1);
  });

  it('given.rpcResult/rpcError build response spec maps', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    const given = await resolveFixture(fixtures.given, {
      request: { post: vi.fn() },
      bucketId: 'w0',
    });
    expect(given.rpcResult('create_chat', { id: 'c1' }, '/api/chats')).toEqual({
      'POST /api/chats create_chat': {
        body: { jsonrpc: '2.0', id: 'x', result: { id: 'c1' } },
      },
    });
    expect(given.rpcError('create_chat', -32000, 'boom', '/api/chats')).toEqual({
      'POST /api/chats create_chat': {
        body: { jsonrpc: '2.0', id: 'x', error: { code: -32000, message: 'boom' } },
      },
    });
  });

  it('_autoFresh is an auto-fixture that calls given.fresh()', async () => {
    const base = makeStubBase();
    const { fixtures } = extendWithGiven(base, {
      mockUrl: 'http://mock',
      bucketHeader: 'x-mock-bucket',
    });
    expect(fixtures._autoFresh[1]).toEqual({ auto: true });
    const fresh = vi.fn().mockResolvedValue();
    await resolveFixture(fixtures._autoFresh, { given: { fresh } });
    expect(fresh).toHaveBeenCalledOnce();
  });
});
