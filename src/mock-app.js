/**
 * Compose an Express app for the mock server.
 *
 * Wires up:
 *   1. `express.json()` body parsing (default 5MB limit; overridable)
 *   2. The `/__mock/*` control endpoints (bucket reset, seed load, patch,
 *      fail-injection, state dump, session list) — same router used by every
 *      consumer
 *   3. The MSW handlers as HTTP middleware — the consumer's domain-specific
 *      routes
 *
 * This is a thin helper that saves ~10 lines of boilerplate per consumer.
 * Consumers who need finer control (custom CORS, auth middleware, etc.) can
 * build the same pipeline by hand — the primitives (createControlRouter and
 * the MSW http-middleware) are exported at the top level.
 *
 * @example
 *   import { createMockApp } from 'msw-terrarium';
 *   import { store, seedLoader, handlers } from './mock-config.js';
 *
 *   export const app = createMockApp({ store, seedLoader, handlers });
 */

import express from 'express';
import { createMiddleware } from '@mswjs/http-middleware';

// eslint-disable-next-line import-x/extensions
import { createControlRouter } from './control.js';

/**
 * @typedef {object} CreateMockAppConfig
 * @property {import('./world.js').Store} store
 *   Bucket-scoped state store from `createBucketedStore`.
 * @property {import('./seed-loader.js').SeedLoader} seedLoader
 *   Seed loader from `createSeedLoader`.
 * @property {Array<import('msw').RequestHandler>} handlers
 *   MSW request handlers. The array shape (spread into `createMiddleware`)
 *   matches what MSW consumers already produce.
 * @property {string} [jsonLimit='5mb']
 *   Body-parser size limit passed to `express.json({ limit })`. Raise for
 *   consumers that seed large binary blobs or table snapshots inline.
 * @property {string} [controlPath='/__mock']
 *   Mount path for the control router. Rarely changed.
 * @property {boolean} [disablePoweredBy=true]
 *   Whether to strip Express's default `x-powered-by` header.
 */

/**
 * Compose the Express app.
 *
 * @param {CreateMockAppConfig} config
 * @returns {import('express').Express}
 */
export function createMockApp({
  store,
  seedLoader,
  handlers,
  jsonLimit = '5mb',
  controlPath = '/__mock',
  disablePoweredBy = true,
}) {
  if (!store || typeof store.forRequest !== 'function') {
    throw new TypeError('createMockApp: store is required (from createBucketedStore)');
  }
  if (!seedLoader || typeof seedLoader.load !== 'function') {
    throw new TypeError('createMockApp: seedLoader is required (from createSeedLoader)');
  }
  if (!Array.isArray(handlers)) {
    throw new TypeError('createMockApp: handlers must be an array of MSW request handlers');
  }

  const app = express();
  if (disablePoweredBy) app.disable('x-powered-by');
  app.use(express.json({ limit: jsonLimit }));
  app.use(controlPath, createControlRouter({ store, seedLoader }));
  app.use(createMiddleware(...handlers));
  return app;
}
