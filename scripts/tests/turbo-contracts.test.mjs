import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const turboCli = path.join(repoRoot, "node_modules", "turbo", "bin", "turbo");

function makeFixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "covel-turbo-contracts-"));
  const workspace = path.join(parent, "workspace");
  mkdirSync(workspace);
  for (const name of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "turbo.json",
    "tsconfig.json",
    "mise.toml",
  ]) {
    copyFileSync(path.join(repoRoot, name), path.join(workspace, name));
  }
  for (const group of ["apps", "packages", "plugins"]) {
    const sourceGroup = path.join(repoRoot, group);
    for (const entry of readdirSync(sourceGroup, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(sourceGroup, entry.name, "package.json");
      if (!existsSync(source)) continue;
      const target = path.join(workspace, group, entry.name);
      mkdirSync(target, { recursive: true });
      copyFileSync(source, path.join(target, "package.json"));
    }
  }
  return { parent, workspace };
}

function turbo(workspace, args, env = process.env) {
  const result = spawnSync(process.execPath, [turboCli, "run", ...args], {
    cwd: workspace,
    env: { ...env, TURBO_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function dry(workspace, args) {
  const result = JSON.parse(turbo(workspace, [...args, "--dry=json"]));
  return new Map(result.tasks.map((task) => [task.taskId, task]));
}

function task(tasks, id) {
  const found = tasks.get(id);
  assert.ok(found, `${id} missing from Turbo task graph`);
  return found;
}

function writeFixtureFile(workspace, relativePath, contents) {
  const target = path.join(workspace, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

test("Turbo hashes root config, prompts, and shared source into their consumers", () => {
  const { parent, workspace } = makeFixture();
  try {
    writeFixtureFile(
      workspace,
      "packages/shared/src/contract.ts",
      "export const contract = 1;\n",
    );
    const prompt = writeFixtureFile(
      workspace,
      "prompts/contract.md",
      "first prompt\n",
    );

    const serverBefore = dry(workspace, [
      "lint",
      "build",
      "--filter=@covel/server",
    ]);
    const initialLint = task(serverBefore, "@covel/server#lint").hash;
    const initialBuild = task(serverBefore, "@covel/server#build").hash;
    const tsconfig = path.join(workspace, "tsconfig.json");
    writeFileSync(tsconfig, `${readFileSync(tsconfig, "utf8")}\n`);
    const serverAfter = dry(workspace, [
      "lint",
      "build",
      "--filter=@covel/server",
    ]);
    assert.notEqual(task(serverAfter, "@covel/server#lint").hash, initialLint);
    assert.notEqual(
      task(serverAfter, "@covel/server#build").hash,
      initialBuild,
    );

    const promptBefore = dry(workspace, [
      "test",
      "--filter=@covel/create",
      "--filter=@covel/server",
    ]);
    writeFileSync(prompt, "second prompt\n");
    const promptAfter = dry(workspace, [
      "test",
      "--filter=@covel/create",
      "--filter=@covel/server",
    ]);
    for (const id of ["@covel/create#test", "@covel/server#test"]) {
      assert.notEqual(task(promptAfter, id).hash, task(promptBefore, id).hash);
    }

    const desktopBefore = dry(workspace, [
      "lint",
      "test",
      "--filter=@covel/desktop",
    ]);
    for (const id of ["@covel/desktop#lint", "@covel/desktop#test"]) {
      assert.deepEqual(task(desktopBefore, id).dependencies, [
        "@covel/shared#build",
      ]);
    }
    assert.equal(desktopBefore.has("@covel/web#build"), false);
    writeFixtureFile(
      workspace,
      "packages/shared/src/contract.ts",
      "export const contract = 2;\n",
    );
    const desktopAfter = dry(workspace, [
      "lint",
      "test",
      "--filter=@covel/desktop",
    ]);
    for (const id of ["@covel/desktop#lint", "@covel/desktop#test"]) {
      assert.notEqual(
        task(desktopAfter, id).hash,
        task(desktopBefore, id).hash,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("PostgreSQL test env reaches Turbo child and uncached test runs twice", () => {
  const { parent, workspace } = makeFixture();
  try {
    const marker = path.join(parent, "store-test-runs.jsonl");
    const storeDir = path.join(workspace, "packages", "store");
    const manifestPath = path.join(storeDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts.test = "node fake-store-test.mjs";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(
      path.join(storeDir, "fake-store-test.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, JSON.stringify({ database: process.env.DATABASE_URL, required: process.env.COVEL_REQUIRE_PG_TESTS }) + "\\n");\n`,
    );

    const env = {
      ...process.env,
      DATABASE_URL: "postgresql://test.invalid/covel",
      COVEL_REQUIRE_PG_TESTS: "1",
    };
    for (let i = 0; i < 2; i += 1) {
      turbo(workspace, ["test", "--filter=@covel/store", "--only"], env);
    }
    const runs = readFileSync(marker, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(runs, [
      { database: env.DATABASE_URL, required: "1" },
      { database: env.DATABASE_URL, required: "1" },
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
