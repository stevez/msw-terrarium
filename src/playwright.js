/* eslint-disable react-hooks/rules-of-hooks --
   `use` here is the Playwright fixture callback, not React's use() hook.
   Playwright's fixture API mandates this parameter name. */

/**
 * Playwright fixture factory — framework (Tier 1).
 *
 * Given a base Playwright `test` object and a config, returns an extended
 * `test` with:
 *   - worker-scoped `bucketId` fixture (unique per Playwright worker)
 *   - `page` fixture that attaches the bucket header on every request,
 *     with an optional `beforePage` hook for consumer setup (e.g. session
 *     cookies)
 *   - `given` fixture — a fluent API for driving /__mock/* endpoints:
 *       fresh()         → POST /__mock/reset
 *       load(...names)  → POST /__mock/load { seeds: [...] }
 *       patch(data)     → POST /__mock/patch { data: {...} }
 *       failNext(key, spec, times) → POST /__mock/fail
 *       rpcResult(rpcMethod, result, urlPath) → returns a response spec map
 *       rpcError(rpcMethod, code, message, urlPath) → returns a response spec map
 *   - `_autoFresh` auto-fixture that calls `given.fresh()` before every
 *     test using this `test` object
 */

/**
 * @typedef {object} GivenFixtureConfig
 * @property {string} mockUrl                     e.g. 'http://localhost:9090'
 * @property {string} bucketHeader                e.g. 'x-mock-bucket'
 * @property {(page: import('@playwright/test').Page) => Promise<void>} [beforePage]
 *   Optional hook, runs before the bucket header is attached to the page.
 *   Use to set session cookies, log the user in, etc.
 */

/**
 * @param {import('@playwright/test').TestType} base
 * @param {GivenFixtureConfig} config
 * @returns {import('@playwright/test').TestType}
 */
export function extendWithGiven(base, { mockUrl, bucketHeader, beforePage }) {
  return base.extend({
    // Worker-scoped bucket ID. One bucket per Playwright worker; every
    // test in this worker shares the same bucket. Isolation between tests
    // within a worker is via _autoFresh below.
    bucketId: [
      // eslint-disable-next-line no-empty-pattern
      async ({}, use, workerInfo) => {
        await use(`w${workerInfo.workerIndex}`);
      },
      { scope: 'worker' },
    ],

    page: async ({ page, bucketId }, use) => {
      if (beforePage) await beforePage(page);
      await page.setExtraHTTPHeaders({ [bucketHeader]: bucketId });
      await use(page);
    },

    given: async ({ request, bucketId }, use) => {
      const headers = { [bucketHeader]: bucketId };
      const api = {
        async fresh() {
          await request.post(`${mockUrl}/__mock/reset`, { headers });
        },
        async load(...seeds) {
          await request.post(`${mockUrl}/__mock/load`, {
            headers,
            data: { seeds },
          });
        },
        async patch(data) {
          await request.post(`${mockUrl}/__mock/patch`, {
            headers,
            data: { data },
          });
        },
        async failNext(key, spec, times = 1) {
          await request.post(`${mockUrl}/__mock/fail`, {
            headers,
            data: { key, spec, times },
          });
        },
        // JSON-RPC ergonomic helpers — every backend endpoint speaks JSON-RPC.
        rpcResult(rpcMethod, result, urlPath) {
          return {
            [`POST ${urlPath} ${rpcMethod}`]: {
              body: { jsonrpc: '2.0', id: 'x', result },
            },
          };
        },
        rpcError(rpcMethod, code, message, urlPath) {
          return {
            [`POST ${urlPath} ${rpcMethod}`]: {
              body: { jsonrpc: '2.0', id: 'x', error: { code, message } },
            },
          };
        },
      };
      await use(api);
    },

    // Auto-reset the bucket before every test that uses this `test` object.
    // Costs ~1 ms per test (a single POST /__mock/reset).
    //
    // Declared as an auto-fixture on this test object (not as a top-level
    // `test.beforeEach`) so specs that build their own `test` from
    // `@playwright/test` — e.g. specs that only import `setSessionCookie`
    // for a side effect — are not affected. A module-scope `beforeEach`
    // here would leak into those specs via the import graph and error out
    // with "unknown parameter 'given'".
    _autoFresh: [
      async ({ given }, use) => {
        await given.fresh();
        await use();
      },
      { auto: true },
    ],
  });
}
