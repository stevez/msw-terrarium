import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeedLoader } from '../src/seed-loader.js';

let seedsDir;

beforeAll(() => {
  seedsDir = mkdtempSync(join(tmpdir(), 'sms-seed-'));
  writeFileSync(
    join(seedsDir, 'basic.json'),
    JSON.stringify({
      chat: [
        { id: 'c1', title: 'First' },
        { id: 'c2', title: 'Second' },
      ],
      responses: { 'GET /x': { body: { pinned: true } } },
    }),
  );
  writeFileSync(
    join(seedsDir, 'upsert.json'),
    JSON.stringify({ chat: [{ id: 'c1', title: 'Renamed' }] }),
  );
});

afterAll(() => {
  rmSync(seedsDir, { recursive: true, force: true });
});

/** Minimal collection stub — records create/update calls. */
function stubCollection() {
  const rows = [];
  return {
    rows,
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
  };
}

function stubWorld() {
  return {
    responses: {},
    failures: {},
    streams: {},
    meta: { delayMs: 0, errorRate: 0 },
    db: { chat: stubCollection() },
  };
}

describe('createSeedLoader', () => {
  it('throws when seedsDir is missing', () => {
    expect(() => createSeedLoader({})).toThrow(/seedsDir must be a non-empty string/);
  });

  it('load() parses a valid JSON seed file', () => {
    const loader = createSeedLoader({ seedsDir });
    const seed = loader.load('basic');
    expect(seed.chat).toHaveLength(2);
    expect(seed.responses['GET /x'].body).toEqual({ pinned: true });
  });

  it('load() rejects names with path separators or ../', () => {
    const loader = createSeedLoader({ seedsDir });
    expect(() => loader.load('../secret')).toThrow(/Invalid seed name/);
    expect(() => loader.load('foo/bar')).toThrow(/Invalid seed name/);
    expect(() => loader.load('')).toThrow(/Invalid seed name/);
    expect(() => loader.load(null)).toThrow(/Invalid seed name/);
  });

  it('apply() creates rows in the matching collection', async () => {
    const loader = createSeedLoader({ seedsDir });
    const world = stubWorld();
    await loader.apply(world, loader.load('basic'));
    expect(world.db.chat.rows).toEqual([
      { id: 'c1', title: 'First' },
      { id: 'c2', title: 'Second' },
    ]);
  });

  it('apply() merges responses/failures/streams into the world sidecars', async () => {
    const loader = createSeedLoader({ seedsDir });
    const world = stubWorld();
    world.responses['GET /existing'] = { body: 'kept' };
    await loader.apply(world, {
      responses: { 'GET /x': { body: { pinned: true } } },
      failures: { 'POST /y': { spec: { status: 500 }, times: 1 } },
      streams: { 'POST /z': { chunks: ['a'] } },
    });
    expect(world.responses['GET /existing']).toEqual({ body: 'kept' });
    expect(world.responses['GET /x']).toEqual({ body: { pinned: true } });
    expect(world.failures['POST /y']).toBeDefined();
    expect(world.streams['POST /z']).toEqual({ chunks: ['a'] });
  });

  it('apply() upserts rows with matching id', async () => {
    const loader = createSeedLoader({ seedsDir });
    const world = stubWorld();
    await loader.apply(world, loader.load('basic'));
    await loader.apply(world, loader.load('upsert'));
    // c1 renamed, c2 unchanged
    expect(world.db.chat.rows).toEqual([
      { id: 'c1', title: 'Renamed' },
      { id: 'c2', title: 'Second' },
    ]);
  });

  it('apply() throws when a domain key has a non-array value', async () => {
    const loader = createSeedLoader({ seedsDir });
    await expect(loader.apply(stubWorld(), { chat: { id: 'c1' } })).rejects.toThrow(
      /must be an array of rows/,
    );
  });

  it('apply() throws on unknown seed keys', async () => {
    const loader = createSeedLoader({ seedsDir });
    await expect(loader.apply(stubWorld(), { nonexistent: [] })).rejects.toThrow(
      /Unknown seed key/,
    );
  });

  it('apply() overwrites non-DB, non-sidecar keys wholesale (e.g. meta)', async () => {
    const loader = createSeedLoader({ seedsDir });
    const world = stubWorld();
    await loader.apply(world, { meta: { delayMs: 100, errorRate: 0.1 } });
    expect(world.meta).toEqual({ delayMs: 100, errorRate: 0.1 });
  });
});
