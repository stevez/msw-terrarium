/**
 * All-in-one convenience for the common Playwright + msw-terrarium
 * setup. One function call produces `{ test, expect, buildApp, webServer,
 * store, seedLoader }` — everything a consumer typically re-derives.
 *
 * This is opinionated by design: uses the standard control path, standard
 * bucket header (`x-mock-bucket`), Playwright as the test framework, and
 * `start-server-and-test`-style url readiness for the `webServer` slot.
 *
 * Consumers who need custom composition (multiple buckets per worker,
 * multi-app pipelines, non-Playwright test frameworks) should compose the
 * lower-level primitives (`createBucketedStore` + `createMockApp` +
 * `extendWithGiven`) directly instead.
 *
 * @example
 *   import { test as base } from '@playwright/test';
 *   import { definePlaywrightMock } from 'msw-terrarium';
 *   import { createDb, seedBaseline } from './schema.js';
 *   import { createHandlers } from './handlers.js';
 *
 *   export const { test, expect, buildApp, webServer } = definePlaywrightMock({
 *     base,
 *     port: 9090,
 *     schema: { createDb, seedBaseline },
 *     handlers: (ctx) => createHandlers(ctx),
 *     seedsDir: pathResolve(HERE, 'seeds'),
 *     mockUrl: 'http://localhost:9090',
 *   });
 *
 * The resulting `test` object is a Playwright test with worker-scoped
 * `bucketId`, `given` fixture, and `_autoFresh` auto-fixture pre-wired.
 *
 * The `webServer` field is a Playwright `webServer` config fragment ready
 * for `playwright.config.mjs`.
 */

// eslint-disable-next-line import-x/extensions
import { createBucketedStore } from './world.js';
// eslint-disable-next-line import-x/extensions
import { createSeedLoader } from './seed-loader.js';
// eslint-disable-next-line import-x/extensions
import { createMockApp } from './mock-app.js';
// eslint-disable-next-line import-x/extensions
import { extendWithGiven } from './playwright.js';

/**
 * @typedef {object} DefinePlaywrightMockConfig
 * @property {import('@playwright/test').TestType} base
 *   The base `test` object from `@playwright/test`. The returned `test`
 *   extends this with fixtures.
 * @property {number} port
 *   Port the mock server will listen on. Threaded into the `webServer`
 *   config so Playwright waits for it before running specs.
 * @property {{ createDb: () => object, seedBaseline?: (world: object) => Promise<void> }} schema
 *   Output of `defineSchema(...)`. Provides the per-bucket collections and
 *   optional baseline seeding.
 * @property {(ctx: { store: object }) => Array<import('msw').RequestHandler>} handlers
 *   Called once to produce the MSW handler array. Receives `{ store }` so
 *   handlers can call `store.forRequest(request)` to resolve worlds.
 * @property {string} seedsDir
 *   Absolute path to the seeds directory. Passed to `createSeedLoader`.
 * @property {string} mockUrl
 *   Base URL clients use to reach the mock (e.g. `http://localhost:9090`).
 *   Threaded into the `given` fixture and the `webServer.url` readiness
 *   probe.
 * @property {string} [bucketHeader='x-mock-bucket']
 * @property {string} [bucketCookie='mock-bucket']
 * @property {string} [defaultBucket='default']
 * @property {(page: import('@playwright/test').Page) => Promise<void>} [beforePage]
 *   Optional hook run before the bucket header is attached (e.g. set an
 *   auth cookie). Forwarded to `extendWithGiven`.
 * @property {string} [command]
 *   Optional `webServer.command` to boot the mock server. Falls back to a
 *   sensible default if omitted — but consumers usually specify their own.
 * @property {number} [webServerTimeout=60_000]
 *   Milliseconds Playwright waits for the mock to answer at `mockUrl`
 *   before failing the run.
 */

/**
 * @typedef {object} DefinePlaywrightMockResult
 * @property {import('@playwright/test').TestType} test
 *   Playwright test object with `bucketId` (worker-scoped), `page` (bucket
 *   header attached), `given` (fluent API), `_autoFresh` (auto-reset).
 * @property {import('@playwright/test').Expect} expect
 *   Re-exported from `@playwright/test` for convenience.
 * @property {() => import('express').Express} buildApp
 *   Zero-arg factory for the composed Express app. The consumer's boot
 *   script (`e2e/mocks/server.mjs`) calls this and hands the result to
 *   `startMockServer`.
 * @property {object} webServer
 *   Playwright `webServer` config fragment: `{ command, url, timeout, reuseExistingServer }`.
 *   Spread into `playwright.config.mjs`.
 * @property {import('./world.js').Store} store
 *   The bucket store, exposed so handlers imported separately can wire it.
 * @property {import('./seed-loader.js').SeedLoader} seedLoader
 *   The seed loader, exposed for parity with `store`.
 */

/**
 * @param {DefinePlaywrightMockConfig} config
 * @returns {DefinePlaywrightMockResult}
 */
export function definePlaywrightMock({
  base,
  port,
  schema,
  handlers,
  seedsDir,
  mockUrl,
  bucketHeader = 'x-mock-bucket',
  bucketCookie = 'mock-bucket',
  defaultBucket = 'default',
  beforePage,
  command,
  webServerTimeout = 60_000,
}) {
  if (!base || typeof base.extend !== 'function') {
    throw new TypeError(
      'definePlaywrightMock: base must be a Playwright test object',
    );
  }
  if (typeof port !== 'number' || Number.isNaN(port)) {
    throw new TypeError('definePlaywrightMock: port must be a number');
  }
  if (!schema || typeof schema.createDb !== 'function') {
    throw new TypeError(
      'definePlaywrightMock: schema must be an object with a createDb function (from defineSchema)',
    );
  }
  if (typeof handlers !== 'function') {
    throw new TypeError('definePlaywrightMock: handlers must be a function');
  }
  if (typeof seedsDir !== 'string') {
    throw new TypeError('definePlaywrightMock: seedsDir must be a string');
  }
  if (typeof mockUrl !== 'string') {
    throw new TypeError('definePlaywrightMock: mockUrl must be a string');
  }

  const store = createBucketedStore({
    createDb: schema.createDb,
    seedBaseline: schema.seedBaseline,
    bucketHeader,
    bucketCookie,
    defaultBucket,
  });
  const seedLoader = createSeedLoader({ seedsDir });

  const buildApp = () => createMockApp({
    store,
    seedLoader,
    handlers: handlers({ store }),
  });

  const test = extendWithGiven(base, {
    mockUrl,
    bucketHeader,
    beforePage,
  });

  // Re-export expect from the same Playwright module the caller passed in.
  // This lets consumers `import { test, expect }` from one place.
  const { expect } = base;

  const webServer = {
    ...(command ? { command } : {}),
    url: mockUrl,
    timeout: webServerTimeout,
    reuseExistingServer: !process.env.CI,
  };

  return { test, expect, buildApp, webServer, store, seedLoader };
}
