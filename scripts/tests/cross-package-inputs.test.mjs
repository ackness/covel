import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  crossWorkspaceReferences,
  uncachedReferences,
} from "../lib/cross-package-inputs.mjs";

function fixture(manifests, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "covel-cross-inputs-"));
  const workspaces = Object.entries(manifests).map(([directory, manifest]) => {
    mkdirSync(path.join(root, directory), { recursive: true });
    return {
      directory: path.join(root, directory),
      name: path.basename(directory),
      manifest: { scripts: { lint: "tsc", test: "vitest" }, ...manifest },
    };
  });
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return { root, workspaces };
}

function problems({ root, workspaces }, turbo) {
  return uncachedReferences({
    root,
    turbo,
    workspaces,
    references: crossWorkspaceReferences(workspaces),
  }).map(({ workspace, owner, missing }) => [
    workspace.manifest.name,
    owner.manifest.name,
    missing.join("/"),
  ]);
}

const hashed = {
  tasks: { lint: { dependsOn: ["^build"] }, test: { dependsOn: ["^build"] } },
};

test("a relative import into a package that is not a dependency escapes lint and test", () => {
  const f = fixture(
    { "apps/web": { name: "web" }, "packages/runtime": { name: "runtime" } },
    {
      "apps/web/src/helper.ts":
        'import { run } from "../../../packages/runtime/src/index.js";',
      "packages/runtime/src/index.ts": "export const run = 1;",
    },
  );
  try {
    assert.deepEqual(problems(f, hashed), [["web", "runtime", "lint/test"]]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a declared dependency counts only when the task hashes it through ^build", () => {
  const f = fixture(
    {
      "apps/web": { name: "web", devDependencies: { runtime: "workspace:*" } },
      "packages/runtime": { name: "runtime" },
    },
    {
      "apps/web/src/helper.ts":
        'import { run } from "../../../packages/runtime/src/index.js";',
      "packages/runtime/src/index.ts": "export const run = 1;",
    },
  );
  try {
    assert.deepEqual(problems(f, hashed), []);
    assert.deepEqual(
      problems(f, { tasks: { lint: {}, test: { dependsOn: ["^build"] } } }),
      [["web", "runtime", "lint"]],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("dependencies are followed transitively", () => {
  const f = fixture(
    {
      "apps/web": { name: "web", devDependencies: { mid: "workspace:*" } },
      "packages/mid": { name: "mid", dependencies: { runtime: "workspace:*" } },
      "packages/runtime": { name: "runtime" },
    },
    {
      "apps/web/src/helper.ts":
        'import "../../../packages/runtime/src/index.js";',
      "packages/runtime/src/index.ts": "export {};",
    },
  );
  try {
    assert.deepEqual(problems(f, hashed), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("declared inputs cover files, directories and exclude negations", () => {
  const f = fixture(
    { "apps/web": { name: "web" }, "plugins/codex": { name: "codex" } },
    {
      "apps/web/src/panel.test.ts":
        'import panel from "../../../plugins/codex/ui/panel.json";\nconst dir = new URL("../../../plugins/codex/", import.meta.url);',
      "plugins/codex/ui/panel.json": "{}",
    },
  );
  const inputs = (list) => ({
    tasks: { lint: { inputs: list }, test: { inputs: list } },
  });
  try {
    assert.deepEqual(problems(f, inputs([])), [
      ["web", "codex", "lint/test"],
      ["web", "codex", "test"],
    ]);
    assert.deepEqual(
      problems(f, inputs(["$TURBO_DEFAULT$", "$TURBO_ROOT$/plugins/*/ui/**"])),
      [["web", "codex", "test"]],
      "a file glob does not cover reading the whole directory",
    );
    assert.deepEqual(
      problems(f, inputs(["$TURBO_ROOT$/plugins/codex/**"])),
      [],
    );
    assert.deepEqual(
      problems(
        f,
        inputs([
          "$TURBO_ROOT$/plugins/codex/**",
          "!$TURBO_ROOT$/plugins/codex/ui/**",
        ]),
      ),
      [
        ["web", "codex", "lint/test"],
        ["web", "codex", "test"],
      ],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("directory reads require all descendants, including future files, to be hashed", () => {
  const f = fixture(
    { "apps/web": { name: "web" }, "plugins/codex": { name: "codex" } },
    {
      "apps/web/src/panel.test.ts":
        'const dir = new URL("../../../plugins/codex/", import.meta.url);',
      "plugins/codex/ui/panel.json": "{}",
    },
  );
  const check = (...inputs) => problems(f, { tasks: { test: { inputs } } });
  try {
    for (const input of [
      "$TURBO_ROOT$/plugins/codex/ui/**",
      "$TURBO_ROOT$/plugins/codex/*.json",
      "$TURBO_ROOT$/plugins/codex/*",
      "$TURBO_ROOT$/plugins/codex/any/**",
      "$TURBO_ROOT$/plugins/codex/ui/panel.json",
    ])
      assert.deepEqual(check(input), [["web", "codex", "test"]], input);
    for (const input of [
      "$TURBO_ROOT$/plugins/codex/**",
      "$TURBO_ROOT$/plugins/*/**",
      "$TURBO_ROOT$/plugins/**",
    ])
      assert.deepEqual(check(input), [], input);
    assert.deepEqual(
      check(
        "$TURBO_ROOT$/plugins/codex/**",
        "!$TURBO_ROOT$/plugins/codex/future/**",
      ),
      [["web", "codex", "test"]],
    );
    assert.deepEqual(
      check("$TURBO_ROOT$/plugins/codex/**", "!$TURBO_ROOT$/plugins/other/**"),
      [],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("uncached tasks, own files and unrelated literals are not reported", () => {
  const f = fixture(
    { "apps/server": { name: "server" }, "plugins/codex": { name: "codex" } },
    {
      "apps/server/src/own.ts":
        'import "./nested/own.js"; const x = "../../elsewhere";',
      "apps/server/tests/api.test.ts":
        'import "../../../plugins/codex/index.js";',
      "plugins/codex/index.js": "export {};",
    },
  );
  try {
    assert.deepEqual(
      problems(f, { tasks: { test: { cache: false }, lint: {} } }),
      [["server", "codex", "lint"]],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
