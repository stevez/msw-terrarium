import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { definePlaywrightMock } from '../src/define.js';
import { defineSchema } from '../src/schema.js';

/** Stub `base` mimicking Playwright's test object. */
function makeStubBase() {
  return {
    extend(fixtures) { return { fixtures, __isTest: true }; },
    expect: '__stub-expect__',
  };
}

const chatSchema = z.object({ id: z.string(), title: z.string() });

const testSchema = defineSchema({
  chat: { schema: chatSchema, idPrefix: 'chat' },
});

let seedsDir;

beforeEach(() => {
  seedsDir = mkdtempSync(join(tmpdir(), 'sms-define-'));
});

afterEach(() => rmSync(seedsDir, { recursive: true, force: true }));

describe('definePlaywrightMock (validation)', () => {
  const validConfig = () => ({
    base: makeStubBase(),
    port: 9090,
    schema: testSchema,
    handlers: () => [],
    seedsDir,
    mockUrl: 'http://localhost:9090',
  });

  it('throws when base is missing/invalid', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), base: null })).toThrow(
      /base must be a Playwright test object/,
    );
    expect(() => definePlaywrightMock({ ...validConfig(), base: {} })).toThrow(
      /base must be a Playwright test object/,
    );
  });

  it('throws when port is not a number', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), port: '9090' })).toThrow(
      /port must be a number/,
    );
  });

  it('throws when schema has no createDb', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), schema: {} })).toThrow(
      /schema must be an object with a createDb function/,
    );
  });

  it('throws when handlers is not a function', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), handlers: [] })).toThrow(
      /handlers must be a function/,
    );
  });

  it('throws when seedsDir is not a string', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), seedsDir: null })).toThrow(
      /seedsDir must be a string/,
    );
  });

  it('throws when mockUrl is not a string', () => {
    expect(() => definePlaywrightMock({ ...validConfig(), mockUrl: null })).toThrow(
      /mockUrl must be a string/,
    );
  });
});

describe('definePlaywrightMock (returned surface)', () => {
  it('returns test, expect, buildApp, webServer, store, seedLoader', () => {
    const base = makeStubBase();
    const result = definePlaywrightMock({
      base,
      port: 9090,
      schema: testSchema,
      handlers: () => [],
      seedsDir,
      mockUrl: 'http://localhost:9090',
    });
    expect(Object.keys(result).sort()).toEqual([
      'buildApp', 'expect', 'seedLoader', 'store', 'test', 'webServer',
    ]);
    expect(result.test.__isTest).toBe(true);
    expect(result.expect).toBe('__stub-expect__');
    expect(typeof result.buildApp).toBe('function');
    expect(typeof result.store.forRequest).toBe('function');
    expect(typeof result.seedLoader.load).toBe('function');
  });

  it('test object has bucketId, page, given, _autoFresh fixtures', () => {
    const base = makeStubBase();
    const { test } = definePlaywrightMock({
      base,
      port: 9090,
      schema: testSchema,
      handlers: () => [],
      seedsDir,
      mockUrl: 'http://localhost:9090',
    });
    expect(Object.keys(test.fixtures).sort()).toEqual(
      ['_autoFresh', 'bucketId', 'given', 'page'],
    );
  });

  it('webServer fragment contains url, timeout, reuseExistingServer', () => {
    const { webServer } = definePlaywrightMock({
      base: makeStubBase(),
      port: 9090,
      schema: testSchema,
      handlers: () => [],
      seedsDir,
      mockUrl: 'http://localhost:9090',
      webServerTimeout: 30_000,
    });
    expect(webServer.url).toBe('http://localhost:9090');
    expect(webServer.timeout).toBe(30_000);
    expect(webServer.reuseExistingServer).toBe(!process.env.CI);
    // No command by default.
    expect(webServer.command).toBeUndefined();
  });

  it('webServer includes command when provided', () => {
    const { webServer } = definePlaywrightMock({
      base: makeStubBase(),
      port: 9090,
      schema: testSchema,
      handlers: () => [],
      seedsDir,
      mockUrl: 'http://localhost:9090',
      command: 'node e2e/mocks/server.mjs',
    });
    expect(webServer.command).toBe('node e2e/mocks/server.mjs');
  });

  it('buildApp calls handlers({ store }) once each time', () => {
    const handlersSpy = vi.fn(() => []);
    const { buildApp, store } = definePlaywrightMock({
      base: makeStubBase(),
      port: 9090,
      schema: testSchema,
      handlers: handlersSpy,
      seedsDir,
      mockUrl: 'http://localhost:9090',
    });
    buildApp();
    expect(handlersSpy).toHaveBeenCalledOnce();
    expect(handlersSpy).toHaveBeenCalledWith({ store });
  });

  it('honors custom bucketHeader / bucketCookie / defaultBucket', () => {
    const { store } = definePlaywrightMock({
      base: makeStubBase(),
      port: 9090,
      schema: testSchema,
      handlers: () => [],
      seedsDir,
      mockUrl: 'http://localhost:9090',
      bucketHeader: 'x-tenant',
      bucketCookie: 'tenant',
      defaultBucket: 'fallback',
    });
    expect(store.bucketHeader).toBe('x-tenant');
    expect(store.bucketCookie).toBe('tenant');
    expect(store.defaultBucket).toBe('fallback');
  });
});
