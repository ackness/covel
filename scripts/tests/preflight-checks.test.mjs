import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import crossSpawn from "cross-spawn";

import { checkLockfile } from "../check-lockfile.mjs";
import { checkWorkflows } from "../check-workflows.mjs";

test("lockfile check rejects stale workspace manifests without installing or running scripts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "covel-preflight-test-"));
  try {
    const packageDir = path.join(root, "packages", "example");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "test-root",
        private: true,
        scripts: {
          prepare:
            'node -e \'require("fs").writeFileSync("prepare-ran", "yes")\'',
        },
      }),
    );
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    const packagePath = path.join(packageDir, "package.json");
    writeFileSync(
      packagePath,
      JSON.stringify({ name: "example", version: "1.0.0" }),
    );

    const initial = crossSpawn.sync(
      "pnpm",
      ["install", "--lockfile-only", "--ignore-scripts", "--offline"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(initial.status, 0, initial.stderr);
    const lockfilePath = path.join(root, "pnpm-lock.yaml");
    const originalLockfile = readFileSync(lockfilePath);

    checkLockfile(root);
    assert.deepEqual(readFileSync(lockfilePath), originalLockfile);
    assert.equal(existsSync(path.join(root, "node_modules")), false);
    assert.equal(existsSync(path.join(root, "prepare-ran")), false);

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        dependencies: { missing: "1.0.0" },
      }),
    );
    assert.throws(() => checkLockfile(root), /lockfile validation failed/i);
    assert.deepEqual(readFileSync(lockfilePath), originalLockfile);
    assert.equal(existsSync(path.join(root, "node_modules")), false);
    assert.equal(existsSync(path.join(root, "prepare-ran")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow check fails clearly when actionlint is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "covel-workflow-test-"));
  try {
    const workflows = path.join(root, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      path.join(workflows, "test.yaml"),
      "name: Test\non: push\njobs: {}\n",
    );
    assert.throws(
      () => checkWorkflows(root, path.join(root, "missing-actionlint")),
      /actionlint is required.*not installed/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
