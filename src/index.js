/**
 * Public entry for the mock framework (Tier 1).
 *
 * Consumers compose these factories with their own schema, handlers, and
 * seed directory. See e2e/mocks/index.js for a concrete composition.
 *
 * Subpath entry `./playwright` exports `extendWithGiven` for Playwright
 * fixture consumers.
 */

// eslint-disable-next-line import-x/extensions
export { createBucketedStore } from './world.js';
// eslint-disable-next-line import-x/extensions
export { createSeedLoader } from './seed-loader.js';
// eslint-disable-next-line import-x/extensions
export { createControlRouter } from './control.js';
// eslint-disable-next-line import-x/extensions
export { matchResponse, decrementFailure, matchStream, respondFrom } from './sidecars.js';
// eslint-disable-next-line import-x/extensions
export { streamResponse } from './stream.js';
// eslint-disable-next-line import-x/extensions
export { createMockApp } from './mock-app.js';
// eslint-disable-next-line import-x/extensions
export { startMockServer } from './mock-server.js';
// eslint-disable-next-line import-x/extensions
export { createRestHandlers } from './rest.js';
// eslint-disable-next-line import-x/extensions
export { defineSchema } from './schema.js';
// eslint-disable-next-line import-x/extensions
export { definePlaywrightMock } from './define.js';
