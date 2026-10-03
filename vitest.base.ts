export default {
  test: {
    include: ["tests/**/*.test.ts"],
    // PG-backed integration files create and drop a real database per worker,
    // and `store.close()` must drain a connection pool before the isolated
    // `DROP DATABASE ... WITH (FORCE)` can run. Under `turbo test` all of those
    // workers share the host CPU, so the hook's wall-clock budget absorbs CPU
    // preemption that has nothing to do with the DDL itself. 60s covers a
    // saturated run; a genuinely hung teardown still fails loudly.
    hookTimeout: 60_000,
    // The same holds for tests. The default of 5 s is a speed limit: a test
    // that parses a world package or imports the server passes alone and
    // times out when every package runs at once. A time limit is there to
    // catch a hang, and 30 s still does.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
} as const;
