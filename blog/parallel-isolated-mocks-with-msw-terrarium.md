# Parallel, isolated Playwright mocks with msw-terrarium

*How a shared mock server forces your integration tests to run one at a time — and how bucket-scoped isolation fixes it for real, demonstrated on a real app.*

## The constraint

[`nextcov-example`](https://github.com/stevez/nextcov-example) is a small Next.js Todo app used to demonstrate three-tier test coverage. Its integration tests run against a real SSR build, backed by a mock API server (`json-server`) standing in for a real backend. The README says, plainly:

> The current solution for SSR test is by changing the mock server data before each test, which means tests can only be run serially. Parallel testing is not supported at the moment.

That's not a hypothetical problem — it's the actual state of a real project. And it's a common one. Playwright defaults to running specs across multiple workers (`fullyParallel: true`), but `json-server` boots a single instance with a single in-memory database. Every worker's requests land in the same JSON blob. Reset the data for one test and you've just pulled the rug out from under whatever the other three workers were doing.

The workaround in most projects that hit this — including this one — is to force `workers: 1` on CI and accept the slower run. It works. It also throws away the entire point of `fullyParallel`.

## Why a "smarter" mock doesn't fix it by itself

The instinct is to make the mock stateful — track created/deleted rows instead of returning the same canned JSON every time — so tests can do real round-trip assertions ("create a task, see it in the list, delete it, see it gone"). That's `msw-terrarium`'s whole reason to exist. But stateful alone isn't sufficient here: a *single, shared* stateful mock is actually worse under parallelism than a stateless one, because now workers don't just race on read timing, they mutate a database out from under each other.

The fix isn't "make it stateful." It's "make it stateful *and* give every worker its own copy of that state." One in-memory "world" per Playwright worker, keyed off a header the mock server reads on every request. Nothing shared, nothing to race on, no ordering dependency between tests in different workers.

That's the isolation model in [`msw-terrarium`](https://github.com/stevez/msw-terrarium): a bucket-scoped mock server built on [MSW](https://mswjs.io) and [`@msw/data`](https://github.com/mswjs/data). Each worker gets a header (`x-mock-bucket: w0`, `w1`, ...), and the mock server routes every request — reads and writes — to that worker's own in-memory `World`. Reset one bucket, and every other bucket is untouched.

## Porting the Todo app's mock layer

The demo lives at [`stevez/msw-terrarium-example`](https://github.com/stevez/msw-terrarium-example) — a fork of `nextcov-example` with the mock layer swapped out. Everything else about the app (the Next.js UI, the `nextcov` three-tier coverage setup, the unit/component tests) is untouched; this is a surgical swap of one layer, not a rewrite.

### Schema

```js
// e2e/mocks/schema.js
import { z } from 'zod';
import { defineSchema } from 'msw-terrarium';

export const { createDb, seedBaseline } = defineSchema({
  task: {
    schema: z.object({
      id: z.string(),
      text: z.string(),
    }),
    idPrefix: 'task',
  },
  // No baseline — every fresh bucket starts genuinely empty.
});
```

The old `json-server` setup always started from a canned `db.json` with four tasks in it, because a shared mock has no per-test notion of "starting state" — the app's initial state *was* the shared data. With bucket isolation, every fresh world starts empty by default, and tests declare what they need explicitly.

### Handlers

```js
// e2e/mocks/handlers.js
import { createRestHandlers } from 'msw-terrarium';

export function createHandlers({ store }) {
  return createRestHandlers({
    store,
    routes: {
      'GET /tasks': ({ world }) => ({
        body: world.db.task.findMany((q) => q.where({})),
      }),
      'POST /tasks': async ({ world, body }) => {
        const task = await world.db.task.createNext(body);
        return { status: 201, body: task };
      },
      'PUT /tasks/:id': async ({ world, params, body }) => {
        const existing = world.db.task.findFirst((q) => q.where({ id: params.id }));
        if (!existing) return { status: 404 };
        await world.db.task.update(existing, {
          data(current) { Object.assign(current, body); },
        });
        return { status: 200, body: world.db.task.findFirst((q) => q.where({ id: params.id })) };
      },
      'DELETE /tasks/:id': ({ world, params }) => {
        const target = world.db.task.findFirst((q) => q.where({ id: params.id }));
        if (!target) return { status: 404 };
        world.db.task.delete(target);
        return { status: 204 };
      },
    },
  });
}
```

A declarative `{ 'METHOD /path': handler }` table over the same four REST endpoints the app already called — nothing about the app's own `fetch` calls had to change.

### Explicit seeding instead of baked-in fixtures

The four canned tasks from the old `db.json` became a named seed instead of default state:

```json
// e2e/mocks/seeds/default-tasks.json
{ "task": [
  { "id": "4e5e6ca4-74e3-4b0b-afdb-b88cafe41e5b", "text": "HackerRank Problem solving part 1" },
  { "id": "d3493707-26ac-4b84-9333-ee645215c784", "text": "Join the progress review meeting at 9pm" },
  { "id": "6a44458b-67c3-47a7-9ef0-317998a60d0e", "text": "write an article about the \"Create Todo App Using Next JS\"" },
  { "id": "fe3eefca-90d1-4285-80d6-4d698f9f4660", "text": "create the Monthly presentation" }
] }
```

```ts
// e2e/todo-app.spec.ts
test.describe("ToDo App", () => {
  test.beforeEach(async ({ given }) => {
    await given.load("default-tasks");
  });

  test("list when empty tasks", async ({ page, given }) => {
    await given.fresh(); // this one test wants a genuinely empty bucket
    await page.goto("/");
    await expect(page.getByText("No task")).toBeVisible();
  });

  // ...edit / delete / finish tests, unchanged, now running against a
  // per-worker bucket instead of a shared json-server instance
});
```

That `"list when empty tasks"` test was **`test.skip`'d** in the original app — the old mock had no way to represent "this worker's data is empty" without stepping on every other worker's fixtures. With bucket isolation it's the *default* state, so the test just... works. Un-skipping it was a one-line diff.

### Wiring

```js
// e2e/mocks/index.js
export const store = createBucketedStore({
  createDb, seedBaseline,
  bucketHeader: 'x-mock-bucket',
});
export const seedLoader = createSeedLoader({ seedsDir: resolve(HERE, 'seeds') });
export function buildMockServer() {
  return createMockApp({ store, seedLoader, handlers: createHandlers({ store }) });
}
```

```js
// e2e/mocks/server.mjs
const { buildMockServer } = await import('./index.js');
const { startMockServer } = await import('msw-terrarium');
startMockServer(buildMockServer(), { port: 3001, name: 'mock server' });
```

```ts
// e2e/fixtures.ts — composed with the app's existing nextcov coverage fixture
const withGiven = extendWithGiven(base, {
  mockUrl: "http://localhost:3001",
  bucketHeader: "x-mock-bucket",
});

const test = withGiven.extend<{ coverage: void }>({
  coverage: [async ({ page }, use, testInfo) => {
    await collectClientCoverage(page, testInfo, use, nextcov);
  }, { auto: true }],
});
```

`extendWithGiven` layers cleanly under the app's own fixture (worker-scoped `bucketId`, a `page` fixture that auto-attaches the bucket header, and the `given.*` API) without touching how `nextcov` collects coverage. Two orthogonal libraries, composed via the same `.extend()` call Playwright already gives you.

The app's own SSR fetch layer (`src/api/api.ts`) already forwarded a custom header end-to-end — browser → Next.js SSR → outgoing `fetch` to the mock — from an earlier, unfinished attempt at parallel isolation. Renaming that header to `x-mock-bucket`, msw-terrarium's own default, was the only change needed in application code.

## The result

Before, `playwright.config.ts` had:

```ts
workers: process.env.CI ? 1 : undefined,
```

After:

```ts
workers: process.env.CI ? 4 : undefined,
```

Running the full integration suite locally (`npm run integration-test`):

```
Running 5 tests using 5 workers
  ok 1 › list when empty tasks (410ms)
  ok 5 › finish a task (455ms)
  ok 4 › delete task - cancel the modal (739ms)
  ok 2 › delete task (862ms)
  ok 3 › edit task (859ms)
5 passed (3.5s)
```

And in CI mode (`CI=true npm run integration-test`):

```
Running 5 tests using 4 workers
  ok 4 › list when empty tasks (331ms)
  ok 5 › finish a task (222ms)
  ok 1 › delete task - cancel the modal (634ms)
  ok 2 › delete task (729ms)
  ok 3 › edit task (780ms)
5 passed (3.1s)
```

Five tests, four concurrent workers, each hitting the same mock server on the same port, each getting its own isolated data — including the test that was previously `test.skip`'d because there was no safe way to run it alongside the others. No flaky ordering, no shared fixtures to step around, no `workers: 1` compromise.

## Try it

- Library: [`stevez/msw-terrarium`](https://github.com/stevez/msw-terrarium) · [`npm install msw-terrarium`](https://www.npmjs.com/package/msw-terrarium)
- Full demo: [`stevez/msw-terrarium-example`](https://github.com/stevez/msw-terrarium-example)
