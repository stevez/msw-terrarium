/**
 * Seed loader — framework (Tier 1).
 *
 * Loads named JSON seeds from disk and applies parsed seed objects into a
 * world in place. Consumers configure `seedsDir` when calling
 * `createSeedLoader`.
 *
 * Seed shape (top-level keys):
 *   - `<collectionName>` — array of rows for `world.db[collectionName]`,
 *                          upsert semantics on matching `id`
 *   - `responses`        — pinned response specs, merged into `world.responses`
 *   - `failures`         — transient failure counters, merged into `world.failures`
 *   - `streams`          — streaming response specs, merged into `world.streams`
 *   - anything else present on `world` — overwritten wholesale
 */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

// Seed names must be lowercase alphanumeric with hyphens/underscores only.
// This prevents path-traversal via `../foo` from an HTTP request body.
const SAFE_SEED_NAME = /^[a-z0-9_-]+$/i;

/**
 * If a row with matching id exists, merge in place; otherwise create.
 *
 * @param {import('@msw/data').Collection} collection
 * @param {object} row
 */
async function upsertRow(collection, row) {
  if (row?.id != null) {
    const existing = collection.findFirst((q) => q.where({ id: row.id }));
    if (existing) {
      await collection.update(existing, {
        data(current) {
          Object.assign(current, row);
        },
      });
      return;
    }
  }
  await collection.create(row);
}

/**
 * @typedef {object} SeedLoaderConfig
 * @property {string} seedsDir   absolute path to the directory holding *.json seeds
 */

/**
 * @typedef {object} SeedLoader
 * @property {(name: string) => object} load
 * @property {(world: object, seed: object) => Promise<void>} apply
 * @property {string} seedsDir
 */

/**
 * Build a seed loader scoped to a specific directory.
 *
 * @param {SeedLoaderConfig} config
 * @returns {SeedLoader}
 */
export function createSeedLoader({ seedsDir }) {
  if (typeof seedsDir !== 'string' || !seedsDir) {
    throw new TypeError('createSeedLoader: seedsDir must be a non-empty string');
  }
  const rootDir = pathResolve(seedsDir);

  function load(name) {
    if (typeof name !== 'string' || !SAFE_SEED_NAME.test(name)) {
      throw new Error(`Invalid seed name: ${JSON.stringify(name)}`);
    }
    const path = pathResolve(rootDir, `${name}.json`);
    // pathResolve is anchored at rootDir, and the regex disallows separators
    // — defense-in-depth against traversal.
    if (!path.startsWith(rootDir)) {
      throw new Error(`Seed name escapes seeds dir: ${JSON.stringify(name)}`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  async function apply(world, seed) {
    const entries = Object.entries(seed ?? {});
    // eslint-disable-next-line no-restricted-syntax
    for (const [key, value] of entries) {
      if (key === 'responses') {
        Object.assign(world.responses, value ?? {});
      } else if (key === 'failures') {
        Object.assign(world.failures, value ?? {});
      } else if (key === 'streams') {
        Object.assign(world.streams, value ?? {});
      } else if (world.db && world.db[key]) {
        if (!Array.isArray(value)) {
          throw new Error(`Seed key "${key}" must be an array of rows`);
        }
        // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
        for (const row of value) await upsertRow(world.db[key], row);
      } else if (key in world) {
        // Non-DB domain (meta, ...). Overwrite.
        // eslint-disable-next-line no-param-reassign
        world[key] = value;
      } else {
        throw new Error(`Unknown seed key: "${key}"`);
      }
    }
  }

  return { load, apply, seedsDir: rootDir };
}
