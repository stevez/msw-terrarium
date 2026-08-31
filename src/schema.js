/**
 * Declarative schema builder over `@msw/data`.
 *
 * Wraps the repetitive Collection + counter + `createNext` boilerplate every
 * consumer writes. The consumer declares:
 *
 *   - a StandardSchema-compatible schema per collection (Zod / Valibot / etc.
 *     — anything `new Collection({ schema })` accepts)
 *   - how to generate ids (`idPrefix` or `idFrom(input, n)`)
 *   - optional per-row defaults (`defaults(n)` returns fields merged in
 *     BEFORE the caller's input, so caller overrides always win)
 *   - an optional `baseline` async function to pre-seed the world
 *
 * Returns `{ createDb, seedBaseline }` — ready to hand to
 * `createBucketedStore`.
 *
 * @example
 *   import { defineSchema } from 'msw-terrarium';
 *   import { z } from 'zod';
 *
 *   export const { createDb, seedBaseline } = defineSchema({
 *     chat: {
 *       schema: z.object({ id: z.string(), title: z.string() }),
 *       idPrefix: 'chat',
 *       defaults: (n) => ({ title: `Chat ${n}` }),
 *     },
 *     table: {
 *       schema: tableSchema,
 *       idFrom: (input, n) => input?.display_name ?? `table-${n}`,
 *     },
 *     baseline: async ({ db }) => {
 *       await db.chat.createNext({ title: 'Welcome' });
 *     },
 *   });
 *
 * ### `createNext(input)` semantics
 *
 * For each `createNext(input = {})` call:
 *
 *   1. Increment the per-collection counter `n`.
 *   2. Compute the id — `idFrom(input, n)` if provided, else `\`${idPrefix}-${n}\``.
 *   3. Build the row: `{ id, ...defaults(n), ...input }`.
 *      Caller-supplied fields (including `id`) win via spread order.
 *   4. Call `collection.create(row)`.
 *
 * ### Collection method passthrough
 *
 * All standard `@msw/data` Collection methods (`create`, `findFirst`,
 * `findMany`, `update`, `delete`, `deleteMany`, ...) are preserved on the
 * returned collection via `Object.assign`. `createNext` is added; nothing
 * else is renamed or wrapped.
 */

import { Collection } from '@msw/data';

/**
 * @typedef {object} CollectionSpec
 * @property {unknown} schema
 *   StandardSchema-compatible schema (Zod, Valibot, etc.). Passed to `new Collection({ schema })`.
 * @property {string} [idPrefix]
 *   Convenience: generate ids like `\`${idPrefix}-${n}\``. Ignored when `idFrom` is present.
 * @property {(input: object, n: number) => string} [idFrom]
 *   Custom id computation. Takes precedence over `idPrefix`. Called with the caller's
 *   input object (may be `{}`) and the per-collection counter value `n`.
 * @property {(n: number) => object} [defaults]
 *   Optional per-row default fields merged BEFORE the caller's input, so caller-supplied
 *   values always win.
 */

/**
 * @typedef {object} BaselineContext
 * @property {Record<string, object>} db
 *   The freshly created collections for this world, in the same shape `createDb()` returns.
 *   Use `db.chat.createNext(...)`, `db.table.create(...)`, etc.
 * @property {import('./world.js').World} world
 *   The whole world, in case you need to set sidecars (`world.responses = {...}`).
 */

/**
 * @typedef {(ctx: BaselineContext) => Promise<void>} BaselineFn
 */

/**
 * @typedef {object} DefineSchemaResult
 * @property {() => Record<string, object>} createDb
 * @property {BaselineFn} seedBaseline
 */

const RESERVED_KEYS = new Set(['baseline']);

/**
 * @param {Record<string, CollectionSpec> & { baseline?: BaselineFn }} spec
 * @returns {DefineSchemaResult}
 */
export function defineSchema(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('defineSchema: spec must be an object');
  }

  const baseline = spec.baseline;
  if (baseline !== undefined && typeof baseline !== 'function') {
    throw new TypeError('defineSchema: baseline must be an async function');
  }

  const collectionEntries = Object.entries(spec).filter(([k]) => !RESERVED_KEYS.has(k));
  if (collectionEntries.length === 0) {
    throw new TypeError('defineSchema: spec must declare at least one collection');
  }

  // Validate each collection spec at define time (fail loud, once).
  for (const [name, cspec] of collectionEntries) {
    if (!cspec || typeof cspec !== 'object' || Array.isArray(cspec)) {
      throw new TypeError(`defineSchema["${name}"]: must be an object`);
    }
    if (!cspec.schema) {
      throw new TypeError(`defineSchema["${name}"]: schema is required`);
    }
    if (cspec.idFrom && typeof cspec.idFrom !== 'function') {
      throw new TypeError(`defineSchema["${name}"]: idFrom must be a function`);
    }
    if (cspec.defaults && typeof cspec.defaults !== 'function') {
      throw new TypeError(`defineSchema["${name}"]: defaults must be a function`);
    }
    if (!cspec.idFrom && !cspec.idPrefix) {
      throw new TypeError(
        `defineSchema["${name}"]: either idPrefix or idFrom is required`,
      );
    }
    if (cspec.idPrefix !== undefined && typeof cspec.idPrefix !== 'string') {
      throw new TypeError(`defineSchema["${name}"]: idPrefix must be a string`);
    }
  }

  function createDb() {
    const db = {};
    // One counter object per createDb() call — collections in different worlds
    // (buckets) never share counters.
    const counters = Object.fromEntries(collectionEntries.map(([name]) => [name, 0]));

    for (const [name, cspec] of collectionEntries) {
      const collection = new Collection({ schema: cspec.schema });

      const createNext = (input = {}) => {
        counters[name] += 1;
        const n = counters[name];
        const id = cspec.idFrom
          ? cspec.idFrom(input, n)
          : `${cspec.idPrefix}-${n}`;
        const defaults = cspec.defaults ? cspec.defaults(n) : {};
        // Order: computed id → defaults → input.
        // Input's fields override defaults; input.id (if any) overrides computed id.
        return collection.create({ id, ...defaults, ...input });
      };

      db[name] = Object.assign(collection, { createNext });
    }
    return db;
  }

  async function seedBaseline(world) {
    if (!baseline) return;
    await baseline({ db: world.db, world });
  }

  return { createDb, seedBaseline };
}
