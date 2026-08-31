/**
 * Boot the mock server: listen on a port, tune keep-alive against undici's
 * long connection pool, log a "ready" line for Playwright's webServer, and
 * install a graceful SIGTERM/SIGINT handler.
 *
 * Named `startMockServer` (not `listen`) so the intent reads at the call
 * site: this is the *end* of composition. The returned `http.Server`
 * instance is available for consumers who need to close it explicitly
 * (e.g. in test suites); the SIGTERM handler covers the common case.
 *
 * @example
 *   import { startMockServer } from 'msw-terrarium';
 *   import { app } from './index.js';
 *
 *   startMockServer(app, { port: 9090 });
 *
 * ## Keep-alive tuning
 *
 * Node's default `keepAliveTimeout` is 5s; undici (used by Playwright's
 * `request` and Node's fetch) treats sockets as valid for up to 10 minutes
 * from its own pool's perspective. Under sparse traffic — a Playwright
 * worker idle between tests — the server closes the socket first, the
 * client reuses the (dead) socket for the next request, and the response
 * is a `read ECONNRESET`.
 *
 * Extending the server-side idle window past any realistic inter-request
 * gap closes the race. Node also requires `headersTimeout > keepAliveTimeout`.
 * Defaults here are 65s / 66s: safely above any test scenario, small enough
 * that a genuinely wedged connection frees within a minute.
 */

/**
 * @typedef {object} StartMockServerConfig
 * @property {number} [port=9090]
 *   Port to listen on. Consumers usually thread `process.env.MOCK_SERVER_PORT`
 *   themselves and pass the parsed number.
 * @property {string} [host]
 *   Bind host. Omit to bind all interfaces (default Node behavior). Set to
 *   '127.0.0.1' to restrict to loopback.
 * @property {string} [name='mock server']
 *   Included in the ready log line. Playwright's `webServer.url` waits for
 *   the server to answer — the log line is for humans watching the output.
 * @property {number} [keepAliveTimeout=65_000]
 *   Milliseconds an idle keep-alive socket stays open server-side. See
 *   module docs above for the ECONNRESET rationale.
 * @property {number} [headersTimeout=66_000]
 *   Node requires this to exceed `keepAliveTimeout`.
 * @property {boolean} [handleSignals=true]
 *   Install a SIGTERM/SIGINT handler that calls `server.close()` and then
 *   `closeAllConnections()` to drain gracefully. Disable if the consumer
 *   already manages process signals themselves.
 * @property {(logLine: string) => void} [log=console.log]
 *   Where to write the ready line. Defaults to `console.log`. Override with
 *   a no-op for silent boot.
 */

/**
 * Start the mock server.
 *
 * @param {import('express').Express} app
 *   Express app (usually from `createMockApp`).
 * @param {StartMockServerConfig} [config]
 * @returns {import('http').Server}
 *   The underlying Node HTTP server. Consumers who want to close it
 *   programmatically can call `.close()` / `.closeAllConnections()`.
 */
export function startMockServer(app, {
  port = 9090,
  host,
  name = 'mock server',
  keepAliveTimeout = 65_000,
  headersTimeout = 66_000,
  handleSignals = true,
  // eslint-disable-next-line no-console
  log = (line) => console.log(line),
} = {}) {
  if (!app || typeof app.listen !== 'function') {
    throw new TypeError('startMockServer: app must be an Express app (or anything with .listen)');
  }
  if (headersTimeout <= keepAliveTimeout) {
    throw new RangeError(
      `startMockServer: headersTimeout (${headersTimeout}) must be greater than keepAliveTimeout (${keepAliveTimeout})`,
    );
  }

  const server = host
    ? app.listen(port, host, () => log(`${name} listening on http://${host}:${port}`))
    : app.listen(port, () => log(`${name} listening on http://localhost:${port}`));

  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = headersTimeout;

  if (handleSignals) {
    const shutdown = (signal) => {
      log(`${name} received ${signal}, shutting down`);
      server.close(() => {
        log(`${name} closed`);
      });
      // Force-close any lingering keep-alive sockets so the process exits
      // promptly rather than waiting up to keepAliveTimeout.
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  return server;
}
