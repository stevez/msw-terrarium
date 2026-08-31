import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineSchema } from '../src/schema.js';

const chatSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'archived']).default('active'),
});

const messageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  content: z.string(),
});

const tableSchema = z.object({
  id: z.string(),
  display_name: z.string(),
});

describe('defineSchema (validation)', () => {
  it('throws when spec is null/undefined/array', () => {
    expect(() => defineSchema(null)).toThrow(/spec must be an object/);
    expect(() => defineSchema(undefined)).toThrow(/spec must be an object/);
    expect(() => defineSchema([])).toThrow(/spec must be an object/);
  });

  it('throws when baseline is not a function', () => {
    expect(() =>
      defineSchema({
        chat: { schema: chatSchema, idPrefix: 'chat' },
        baseline: 'nope',
      }),
    ).toThrow(/baseline must be an async function/);
  });

  it('throws when no collections declared', () => {
    expect(() => defineSchema({})).toThrow(/must declare at least one collection/);
    expect(() => defineSchema({ baseline: async () => {} })).toThrow(
      /must declare at least one collection/,
    );
  });

  it('throws when a collection has no schema', () => {
    expect(() => defineSchema({ chat: { idPrefix: 'chat' } })).toThrow(
      /schema is required/,
    );
  });

  it('throws when neither idPrefix nor idFrom is provided', () => {
    expect(() => defineSchema({ chat: { schema: chatSchema } })).toThrow(
      /either idPrefix or idFrom is required/,
    );
  });

  it('throws when idFrom is not a function', () => {
    expect(() =>
      defineSchema({ chat: { schema: chatSchema, idFrom: 'nope' } }),
    ).toThrow(/idFrom must be a function/);
  });

  it('throws when defaults is not a function', () => {
    expect(() =>
      defineSchema({ chat: { schema: chatSchema, idPrefix: 'chat', defaults: {} } }),
    ).toThrow(/defaults must be a function/);
  });

  it('throws when idPrefix is not a string', () => {
    expect(() =>
      defineSchema({ chat: { schema: chatSchema, idPrefix: 42 } }),
    ).toThrow(/idPrefix must be a string/);
  });

  it('throws when a collection spec is not an object', () => {
    expect(() => defineSchema({ chat: 'invalid' })).toThrow(/must be an object/);
  });
});

describe('defineSchema (createDb)', () => {
  it('returns collections keyed by declared name', () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
      message: { schema: messageSchema, idPrefix: 'msg' },
    });
    const db = createDb();
    expect(Object.keys(db).sort()).toEqual(['chat', 'message']);
    expect(typeof db.chat.create).toBe('function');
    expect(typeof db.chat.createNext).toBe('function');
    expect(typeof db.chat.findMany).toBe('function');
  });

  it('createNext generates sequential ids using idPrefix', async () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
    });
    const db = createDb();
    const a = await db.chat.createNext({ title: 'A' });
    const b = await db.chat.createNext({ title: 'B' });
    expect(a.id).toBe('chat-1');
    expect(b.id).toBe('chat-2');
  });

  it('createNext applies defaults BEFORE input (input wins)', async () => {
    const { createDb } = defineSchema({
      chat: {
        schema: chatSchema,
        idPrefix: 'chat',
        defaults: (n) => ({ title: `Default ${n}` }),
      },
    });
    const db = createDb();
    const withOverride = await db.chat.createNext({ title: 'Custom' });
    expect(withOverride.title).toBe('Custom');
    expect(withOverride.id).toBe('chat-1');

    const withDefault = await db.chat.createNext();
    expect(withDefault.title).toBe('Default 2');
  });

  it('input.id overrides the computed id via spread order', async () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
    });
    const db = createDb();
    const row = await db.chat.createNext({ id: 'my-explicit-id', title: 'X' });
    expect(row.id).toBe('my-explicit-id');
  });

  it('idFrom takes precedence over idPrefix', async () => {
    const { createDb } = defineSchema({
      table: {
        schema: tableSchema,
        idPrefix: 'ignored',
        idFrom: (input, n) => input?.display_name ?? `table-${n}`,
      },
    });
    const db = createDb();
    const withName = await db.table.createNext({ display_name: 'sales' });
    expect(withName.id).toBe('sales');

    const withoutName = await db.table.createNext({ display_name: 'x' });
    // idFrom returns display_name from input, so id is 'x' — not table-2
    expect(withoutName.id).toBe('x');
  });

  it('idFrom receives the counter for fallback ids', async () => {
    const seen = [];
    const { createDb } = defineSchema({
      table: {
        schema: tableSchema,
        idFrom: (input, n) => {
          seen.push(n);
          return `t-${n}`;
        },
      },
    });
    const db = createDb();
    await db.table.createNext({ display_name: 'a' });
    await db.table.createNext({ display_name: 'b' });
    await db.table.createNext({ display_name: 'c' });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('counters are per-createDb call — different worlds are isolated', async () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
    });
    const db1 = createDb();
    const db2 = createDb();
    const a1 = await db1.chat.createNext({ title: 'A' });
    const b1 = await db1.chat.createNext({ title: 'B' });
    const a2 = await db2.chat.createNext({ title: 'A' });
    expect(a1.id).toBe('chat-1');
    expect(b1.id).toBe('chat-2');
    // db2 has its own counter starting at 0
    expect(a2.id).toBe('chat-1');
  });

  it('counters are per-collection within a db (message counter is independent of chat)', async () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
      message: { schema: messageSchema, idPrefix: 'msg' },
    });
    const db = createDb();
    await db.chat.createNext({ title: 'A' });
    await db.chat.createNext({ title: 'B' });
    const msg = await db.message.createNext({ chat_id: 'chat-1', content: 'hi' });
    expect(msg.id).toBe('msg-1');
  });

  it('passes through standard Collection methods (findFirst, findMany, delete)', async () => {
    const { createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
    });
    const db = createDb();
    await db.chat.createNext({ title: 'A' });
    await db.chat.createNext({ title: 'B' });

    const all = db.chat.findMany((q) => q.where({}));
    expect(all).toHaveLength(2);

    const first = db.chat.findFirst((q) => q.where({ title: 'A' }));
    expect(first?.id).toBe('chat-1');

    await db.chat.delete(first);
    expect(db.chat.findMany((q) => q.where({}))).toHaveLength(1);
  });

  it('createNext with no args uses the computed id + defaults', async () => {
    const { createDb } = defineSchema({
      chat: {
        schema: chatSchema,
        idPrefix: 'chat',
        defaults: (n) => ({ title: `Chat ${n}` }),
      },
    });
    const db = createDb();
    const row = await db.chat.createNext();
    expect(row).toMatchObject({ id: 'chat-1', title: 'Chat 1' });
  });
});

describe('defineSchema (seedBaseline)', () => {
  it('returns a no-op when baseline is not provided', async () => {
    const { seedBaseline, createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
    });
    const world = { db: createDb(), responses: {}, failures: {} };
    // Should not throw and should not add any rows.
    await expect(seedBaseline(world)).resolves.toBeUndefined();
    expect(world.db.chat.findMany((q) => q.where({}))).toHaveLength(0);
  });

  it('runs the baseline function with { db, world }', async () => {
    const seen = { got: null };
    const { seedBaseline, createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
      baseline: async ({ db, world }) => {
        seen.got = { db, world };
        await db.chat.createNext({ title: 'Baseline' });
      },
    });
    const world = { db: createDb(), responses: {}, failures: {} };
    await seedBaseline(world);
    expect(seen.got.db).toBe(world.db);
    expect(seen.got.world).toBe(world);
    expect(world.db.chat.findMany((q) => q.where({}))).toHaveLength(1);
    expect(world.db.chat.findFirst((q) => q.where({ title: 'Baseline' }))).toBeDefined();
  });

  it('baseline can set sidecars via world', async () => {
    const { seedBaseline, createDb } = defineSchema({
      chat: { schema: chatSchema, idPrefix: 'chat' },
      baseline: async ({ world }) => {
        world.responses['GET /api/x'] = { body: { pinned: true } };
      },
    });
    const world = { db: createDb(), responses: {}, failures: {} };
    await seedBaseline(world);
    expect(world.responses['GET /api/x']).toEqual({ body: { pinned: true } });
  });
});
