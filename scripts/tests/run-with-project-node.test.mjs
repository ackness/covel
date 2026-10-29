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

function repoPinning(t, node) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "covel-node-pin-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  crossSpawn.sync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "mise.toml"), `[tools]\nnode = "${node}"\n`);
  return repo;
}

test("refuses to run on a Node other than the one mise.toml pins", (t) => {
  const repo = repoPinning(t, "0.0.1");
  const result = crossSpawn.sync(
    process.execPath,
    [runner, "node", "-e", "process.stdout.write('ran')"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(
      `\\[pre-commit\\] Node ${process.versions.node.replaceAll(".", "\\.")} is running this check, but mise\\.toml pins Node 0\\.0\\.1`,
    ),
  );
  assert.match(result.stderr, /mise install/);
});

test("runs the command on the Node that mise.toml pins", (t) => {
  const repo = repoPinning(t, process.versions.node);
  const result = crossSpawn.sync(
    process.execPath,
    [runner, "node", "-e", "process.stdout.write('ran')"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ran");
});
