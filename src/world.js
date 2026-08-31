/**
 * Bucket-scoped state store — framework (Tier 1).
 *
 * A `store` owns:
 *   - a Map<bucketId, world>
 *   - the header/cookie/default bucket resolution
 *   - lazy world creation + baseline seeding
 *
 * Each world holds:
 *   - `responses`: pinned response specs (framework — sidecars.js reads them)
 *   - `failures`:  transient failure counters (framework — sidecars.js reads them)
 *   - `streams`:   pinned streaming response specs (framework — placeholder)
 *   - `meta`:      { delayMs, errorRate } — framework knob
 *   - `db`:        consumer-supplied @msw/data Collections (schema is app-specific)
 *
 * The consumer supplies `createDb` and (optionally) `seedBaseline` when
 * calling `createBucketedStore`. See e2e/mocks/schema.js for a concrete
 * implementation.
 */

/**
 * @typedef {object} ResponseSpec
 * @property {number} [status]
 * @property {object<string,string>} [headers]
 * @property {unknown} body
 * @property {number} [delayMs]
 */

/**
 * @typedef {object} World
 * @property {object<string, ResponseSpec>} responses
 * @property {object<string, { spec: ResponseSpec, times: number }>} failures
 * @property {object<string, unknown>} streams
 * @property {{ delayMs: number, errorRate: number }} meta
 * @property {object<string, import('@msw/data').Collection>} db
 */

/**
 * @typedef {object} StoreConfig
 * @property {() => object<string, import('@msw/data').Collection>} createDb
 * @property {(world: World) => Promise<void>} [seedBaseline]
 * @property {string} [bucketHeader]   default 'x-mock-bucket'
 * @property {string} [bucketCookie]   default 'mock-bucket'
 * @property {string} [defaultBucket]  default 'default'
 */

/**
 * @typedef {object} Store
 * @property {(req: object) => string} resolveBucketId
 * @property {(req: object) => Promise<World>} forRequest
 * @property {(bucketId: string) => void} reset
 * @property {() => void} resetAll
 * @property {() => string[]} list
 * @property {string} bucketHeader
 * @property {string} bucketCookie
 * @property {string} defaultBucket
 */

/**
 * Build a bucket-scoped world store.
 *
 * @param {StoreConfig} config
 * @returns {Store}
 */
export function createBucketedStore({
  createDb,
  seedBaseline,
  bucketHeader = 'x-mock-bucket',
  bucketCookie = 'mock-bucket',
  defaultBucket = 'default',
}) {
  if (typeof createDb !== 'function') {
    throw new TypeError('createBucketedStore: createDb must be a function');
  }

  const worlds = new Map();
  // Track baseline seeding — createFreshWorld is sync but seedBaseline is
  // async (@msw/data create() returns a Promise). We store the seeding
  // Promise so concurrent forRequest() calls await the same completion.
  const seedingPromises = new WeakMap();

  function resolveBucketId(req) {
    const { headers } = req;
    let raw;
    if (headers && typeof headers.get === 'function') {
      raw = headers.get(bucketHeader);
    } else if (headers) {
      raw = headers[bucketHeader];
    }
    if (Array.isArray(raw)) [raw] = raw;
    if (raw) return String(raw);

    const cookieHeader = headers && typeof headers.get === 'function'
      ? headers.get('cookie')
      : headers?.cookie;
    if (cookieHeader) {
      const match = String(cookieHeader).match(
        new RegExp(`(?:^|; )${bucketCookie}=([^;]+)`),
      );
      if (match) return decodeURIComponent(match[1]);
    }

    return defaultBucket;
  }

  function createFreshWorld() {
    return {
      responses: {},
      failures: {},
      streams: {},
      meta: { delayMs: 0, errorRate: 0 },
      db: createDb(),
    };
  }

  async function forRequest(req) {
    const id = resolveBucketId(req);
    let w = worlds.get(id);
    if (!w) {
      w = createFreshWorld();
      worlds.set(id, w);
      if (seedBaseline) {
        const seedPromise = seedBaseline(w);
        seedingPromises.set(w, seedPromise);
        await seedPromise;
        seedingPromises.delete(w);
      }
    } else {
      // Concurrent callers may reach the second branch before the first
      // caller's baseline seed resolves. Wait it out.
      const inflight = seedingPromises.get(w);
      if (inflight) await inflight;
    }
    return w;
  }

  return {
    resolveBucketId,
    forRequest,
    reset(bucketId) { worlds.delete(bucketId); },
    resetAll() { worlds.clear(); },
    list() { return Array.from(worlds.keys()); },
    bucketHeader,
    bucketCookie,
    defaultBucket,
  };
}
