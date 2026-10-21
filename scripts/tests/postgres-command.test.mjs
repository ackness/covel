import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../test-postgres.mjs", import.meta.url));

function fixture(t, exitCode = 0) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "covel-pg-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, "calls.jsonl");
  const script = path.join(directory, "pnpm.cjs");
  writeFileSync(
    script,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
    process.exit(${exitCode});`,
  );
  const shim = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  writeFileSync(
    path.join(directory, shim),
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  return {
    run(databaseUrl) {
      const env = {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      };
      if (databaseUrl === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = databaseUrl;
      return spawnSync(process.execPath, [command], {
        env,
        encoding: "utf8",
      });
    },
    calls() {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

test("PostgreSQL command rejects a missing database instead of skipping tests", (t) => {
  const result = fixture(t).run(undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires DATABASE_URL/);
});

test("PostgreSQL command preserves a failed suite's exit code and stops", (t) => {
  const probe = fixture(t, 7);
  const result = probe.run("postgresql://fixture.invalid/isolated");
  assert.equal(result.status, 7, result.stderr);
  assert.equal(probe.calls().length, 1);
});
