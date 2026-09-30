import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import crossSpawn from "cross-spawn";

const runner = fileURLToPath(
  new URL("../run-with-project-node.mjs", import.meta.url),
);

test("CLI descendants use the selected Node when PATH prioritizes a stale Node", (t) => {
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), "covel-node-path-"));
  t.after(() => rmSync(fakeBin, { recursive: true, force: true }));
  const windows = process.platform === "win32";
  writeFileSync(
    path.join(fakeBin, windows ? "node.cmd" : "node"),
    windows ? "@echo stale-node\r\n" : "#!/bin/sh\nprintf 'stale-node\\n'\n",
    { encoding: "utf8", mode: 0o755 },
  );
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${fakeBin}${path.delimiter}${env[pathKey] ?? ""}`;
  const stale = crossSpawn.sync("node", ["--version"], {
    env,
    encoding: "utf8",
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.stdout.trim(), "stale-node");

  const result = crossSpawn.sync(
    process.execPath,
    [
      runner,
      "node",
      "-e",
      'const {spawnSync} = require("node:child_process"); process.stdout.write(spawnSync("node", ["-p", "process.execPath"], {encoding: "utf8"}).stdout);',
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.execPath);
});

test("propagates a failed command's exit status", () => {
  const result = crossSpawn.sync(
    process.execPath,
    [runner, "node", "-e", "process.exit(7)"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 7, result.stderr);
});
