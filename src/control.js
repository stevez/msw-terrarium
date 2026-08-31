/**
 * Express control router — framework (Tier 1).
 *
 * Mounted at `/__mock/*` by the consumer. Endpoints let Playwright specs
 * (and dev tools) manipulate a bucket's world without going through the app.
 * All are keyed by the store's `bucketHeader` — a spec that hits
 * `/__mock/reset` with header `w0` only resets worker 0's bucket, never
 * any other bucket.
 *
 * Endpoints:
 *   POST /__mock/reset                        drop the bucket → next access re-inits
 *   POST /__mock/load  { seeds: [...] }       reset + apply named seeds in order
 *   POST /__mock/patch { data: {...} }        upsert inline seed on top of current state
 *   POST /__mock/fail  { key, spec, times }   arm a transient failure counter
 *   GET  /__mock/state                        dump the current bucket's world as JSON
 *   GET  /__mock/sessions                     list active bucket IDs (debug)
 *
 * All write endpoints refuse to register when NODE_ENV === 'production'.
 */

import express from 'express';

/**
 * @typedef {object} ControlRouterConfig
 * @property {import('./world.js').Store} store
 * @property {import('./seed-loader.js').SeedLoader} seedLoader
 */

/**
 * @param {ControlRouterConfig} config
 * @returns {import('express').Router}
 */
export function createControlRouter({ store, seedLoader }) {
  if (!store || typeof store.forRequest !== 'function') {
    throw new TypeError('createControlRouter: store is required');
  }
  if (!seedLoader || typeof seedLoader.load !== 'function') {
    throw new TypeError('createControlRouter: seedLoader is required');
  }

  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));

  const isProd = process.env.NODE_ENV === 'production';

  // POST /__mock/reset — drop the bucket's world
  router.post('/reset', (req, res) => {
    if (isProd) return res.status(404).end();
    const bucketId = store.resolveBucketId(req);
    store.reset(bucketId);
    return res.json({ ok: true, bucket: bucketId });
  });

  // POST /__mock/load { seeds: ["name1", "name2", ...] }
  router.post('/load', async (req, res) => {
    if (isProd) return res.status(404).end();
    const bucketId = store.resolveBucketId(req);
    const seeds = Array.isArray(req.body?.seeds) ? req.body.seeds : [];

    // Reset first, then re-init and apply.
    store.reset(bucketId);
    const world = await store.forRequest(req);

    try {
      // eslint-disable-next-line no-restricted-syntax
      for (const name of seeds) {
        // eslint-disable-next-line no-await-in-loop
        await seedLoader.apply(world, seedLoader.load(name));
      }
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    return res.json({ ok: true, bucket: bucketId, seeds });
  });

  // POST /__mock/patch { data: { chat: [...], responses: {...}, ... } }
  router.post('/patch', async (req, res) => {
    if (isProd) return res.status(404).end();
    const bucketId = store.resolveBucketId(req);
    const world = await store.forRequest(req);
    try {
      await seedLoader.apply(world, req.body?.data ?? {});
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    return res.json({ ok: true, bucket: bucketId });
  });

  // POST /__mock/fail { key, spec, times }
  router.post('/fail', async (req, res) => {
    if (isProd) return res.status(404).end();
    const { key, spec, times = 1 } = req.body ?? {};
    if (typeof key !== 'string' || !spec) {
      return res.status(400).json({ ok: false, error: 'key and spec required' });
    }
    const world = await store.forRequest(req);
    world.failures[key] = { spec, times: Number(times) };
    return res.json({ ok: true, bucket: store.resolveBucketId(req), key });
  });

  // GET /__mock/state — dump JSON (debug)
  router.get('/state', async (req, res) => {
    if (isProd) return res.status(404).end();
    const world = await store.forRequest(req);
    const all = (q) => q.where({});
    // Enumerate whatever collections the consumer's createDb built.
    const dbDump = Object.fromEntries(
      Object.entries(world.db ?? {})
        .filter(([, coll]) => typeof coll?.findMany === 'function')
        .map(([name, coll]) => [name, coll.findMany(all)]),
    );
    return res.json({
      bucket: store.resolveBucketId(req),
      db: dbDump,
      responses: world.responses,
      failures: world.failures,
      streams: world.streams,
      meta: world.meta,
    });
  });

  // GET /__mock/sessions — active bucket IDs
  router.get('/sessions', (_req, res) => {
    if (isProd) return res.status(404).end();
    return res.json({ buckets: store.list() });
  });

  return router;
}
