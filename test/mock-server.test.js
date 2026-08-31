import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { startMockServer } from '../src/mock-server.js';

/** Get a free ephemeral port for the test. */
function ephemeralPort() {
  // Node's server.listen(0) picks a free port automatically. We use 0
  // instead of a fixed number so tests never collide with a real service
  // or with each other.
  return 0;
}

/** Wait for a server to actually be listening (address available). */
function untilListening(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (server.listening) {
      // 'listening' event already fired; the listen callback may still be
      // queued as a microtask. Yield once to let it run before resolving.
      setImmediate(resolve);
      return;
    }
    server.once('listening', () => setImmediate(resolve));
  });
}

async function closeServer(server) {
  await new Promise((r) => server.close(r));
}

describe('startMockServer (validation)', () => {
  it('throws when app is missing', () => {
    expect(() => startMockServer(null)).toThrow(/must be an Express app/);
    expect(() => startMockServer({})).toThrow(/must be an Express app/);
  });

  it('throws when headersTimeout <= keepAliveTimeout', () => {
    expect(() =>
      startMockServer(express(), {
        port: ephemeralPort(),
        keepAliveTimeout: 10_000,
        headersTimeout: 10_000,
        handleSignals: false,
      }),
    ).toThrow(/headersTimeout .* must be greater than keepAliveTimeout/);
  });
});

describe('startMockServer (boot)', () => {
  it('listens on the given port, applies keep-alive defaults, and logs ready', async () => {
    const log = vi.fn();
    const server = startMockServer(express(), {
      port: ephemeralPort(),
      name: 'test-mock',
      log,
      handleSignals: false,
    });
    await untilListening(server);
    try {
      expect(server.keepAliveTimeout).toBe(65_000);
      expect(server.headersTimeout).toBe(66_000);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^test-mock listening on http:\/\/localhost:\d+$/),
      );
    } finally {
      await closeServer(server);
    }
  });

  it('honors custom keep-alive tuning', async () => {
    const server = startMockServer(express(), {
      port: ephemeralPort(),
      keepAliveTimeout: 30_000,
      headersTimeout: 31_000,
      handleSignals: false,
      log: () => {},
    });
    await untilListening(server);
    try {
      expect(server.keepAliveTimeout).toBe(30_000);
      expect(server.headersTimeout).toBe(31_000);
    } finally {
      await closeServer(server);
    }
  });

  it('binds to a specific host when provided', async () => {
    const log = vi.fn();
    const server = startMockServer(express(), {
      port: ephemeralPort(),
      host: '127.0.0.1',
      log,
      handleSignals: false,
    });
    await untilListening(server);
    try {
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^mock server listening on http:\/\/127\.0\.0\.1:\d+$/),
      );
    } finally {
      await closeServer(server);
    }
  });
});

describe('startMockServer (signal handling)', () => {
  it('installs SIGTERM/SIGINT handlers when handleSignals=true (default)', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    const server = startMockServer(express(), {
      port: ephemeralPort(),
      log: () => {},
    });
    await untilListening(server);
    try {
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
      expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    } finally {
      // Remove the listeners we added so we don't pollute other tests.
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      await closeServer(server);
    }
  });

  it('does not install signal handlers when handleSignals=false', async () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    const server = startMockServer(express(), {
      port: ephemeralPort(),
      handleSignals: false,
      log: () => {},
    });
    await untilListening(server);
    try {
      expect(process.listenerCount('SIGTERM')).toBe(before.term);
      expect(process.listenerCount('SIGINT')).toBe(before.int);
    } finally {
      await closeServer(server);
    }
  });
});
