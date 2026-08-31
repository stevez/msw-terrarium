# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-31

Initial release.

### Added

- `createBucketedStore` — bucket-scoped in-memory "world" resolver, so parallel Playwright workers never share state.
- `defineSchema` — wraps `@msw/data` collections with id counters and `createNext`.
- `createRestHandlers` — declarative REST route table on top of MSW handlers.
- `createSeedLoader` / `given.load(...)` — JSON seed files with path-traversal guards.
- `given.patch(...)` — upsert rows and pin sidecar overrides (`responses`, `failures`, `streams`) directly from a spec.
- `given.failNext(...)` — arm transient failures for a fixed number of matching requests.
- Streaming response primitive (`streamResponse`) and `streams` sidecar — SSE / NDJSON pinning with `sse-data`, `sse-event`, `ndjson`, and `raw` framing, configurable chunk delay, error sentinels, and abort handling.
- `createControlRouter` — Express router exposing `/__mock/reset|load|patch|fail|state|sessions`, disabled when `NODE_ENV=production`.
- `createMockApp` / `startMockServer` — compose Express + control router + MSW middleware, with keep-alive tuning and SIGTERM handling.
- `definePlaywrightMock` — one-call convenience wrapper for the common setup.
- `extendWithGiven` (`msw-terrarium/playwright`) — Playwright fixture adapter exposing `bucketId`, bucket-tagged `page`, `given`, and an auto-reset (`_autoFresh`) fixture.

[0.1.0]: https://github.com/stevez/msw-terrarium/releases/tag/v0.1.0
