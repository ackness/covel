import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_DIR_MARKER = "COVEL_TEST_TEMP_DIR";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists and belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Give this test run a temp directory of its own and remove it when the
 * process exits.
 *
 * Many tests create a directory under `os.tmpdir()` and never remove it, and
 * Vitest leaves its transform dump there as well: one `pnpm test` left 479
 * directories (481 MB), and a test that scans or watches the temp directory
 * slowed down with it. A Vitest config calls this while it loads. That is
 * before Vitest picks its own directory and before a worker starts, so
 * everything the run creates is under one directory.
 *
 * A run that is killed cannot remove its directory. The name carries the
 * process ID, and the next run removes the directories whose process is gone.
 */
export function useRunTempDir(): void {
  // A config can load twice in one process, and a test can start another
  // test run. Both stay in the directory that exists.
  if (process.env[RUN_DIR_MARKER]) return;
  const base = os.tmpdir();
  for (const name of readdirSync(base)) {
    const owner = Number(/^covel-test-(\d+)-/.exec(name)?.[1]);
    if (owner && !isAlive(owner))
      rmSync(path.join(base, name), { recursive: true, force: true });
  }
  const dir = mkdtempSync(path.join(base, `covel-test-${process.pid}-`));
  for (const name of ["TMPDIR", "TMP", "TEMP", RUN_DIR_MARKER])
    process.env[name] = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
}

useRunTempDir();

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
