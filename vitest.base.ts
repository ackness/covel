import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHostModule } from "./packages/plugin-loader/src/host-modules.js";

const RUN_DIR_MARKER = "COVEL_TEST_TEMP_DIR";

// A run in another PID namespace (a sandboxed agent, a container) looks dead
// from here, so a directory only counts as abandoned once nobody has touched
// it for a while; otherwise a concurrent run could lose its files mid-run.
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

function untouchedForLong(dir: string, now: number): boolean {
  try {
    return now - statSync(dir).mtimeMs > ABANDONED_AFTER_MS;
  } catch {
    return false;
  }
}

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
 * process ID, and a later run removes the directories whose process is gone
 * and that nobody has touched for six hours.
 */
export function useRunTempDir(): void {
  // A config can load twice in one process, and a test can start another
  // test run. Both stay in the directory that exists.
  if (process.env[RUN_DIR_MARKER]) return;
  // macOS aliases /tmp and /var through symlinks. Publish one canonical
  // spelling so fixtures and realpath-based package validation agree, including
  // missing children whose full path cannot be resolved yet.
  const base = realpathSync(os.tmpdir());
  const now = Date.now();
  for (const name of readdirSync(base)) {
    const owner = Number(/^covel-test-(\d+)-/.exec(name)?.[1]);
    const dir = path.join(base, name);
    if (owner && !isAlive(owner) && untouchedForLong(dir, now))
      rmSync(dir, { recursive: true, force: true });
  }
  const dir = mkdtempSync(path.join(base, `covel-test-${process.pid}-`));
  for (const name of ["TMPDIR", "TMP", "TEMP", RUN_DIR_MARKER])
    process.env[name] = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
}

useRunTempDir();

// Tests replace global `fetch` to stand in for a provider. The outbound
// transport uses the global one only where this mark is set, and this file is
// also the setup file of every worker (`setupFiles` below), so the mark exists
// in a test run and nowhere else.
Reflect.set(globalThis, Symbol.for("covel.test.outbound-global-fetch"), true);

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const hostModulesParent = path.join(
  repoRoot,
  "packages/plugin-loader/src/host-modules.ts",
);

/**
 * Vitest loads modules through Vite, where the server's Node resolve hook
 * (`provideHostModules`) does not run. This applies the same rule inside a
 * test: a plugin installed outside the workspace imports the plugin SDK and
 * zod from the host.
 */
const hostModulesOutsideWorkspace = {
  name: "covel-host-modules",
  enforce: "pre" as const,
  async resolveId(
    this: {
      resolve(
        source: string,
        importer: string,
        options: { skipSelf: boolean },
      ): Promise<unknown>;
    },
    source: string,
    importer: string | undefined,
  ) {
    if (!importer || !isHostModule(source)) return null;
    const rel = path.relative(repoRoot, importer.split("?")[0]!);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return null;
    return this.resolve(source, hostModulesParent, { skipSelf: true });
  },
};

export default {
  plugins: [hostModulesOutsideWorkspace],
  test: {
    setupFiles: [fileURLToPath(import.meta.url)],
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
