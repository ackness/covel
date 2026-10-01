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
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
} as const;
