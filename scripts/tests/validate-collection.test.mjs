import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("collection CLI uses prefixed world facts without executing plugin entries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "covel-collection-selection-"));
  const write = (file, content) => {
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "scripts/validate-collection.ts"),
        dir,
      ],
      { cwd: root, encoding: "utf8" },
    );
  try {
    write(
      "covel-collection.yaml",
      "schemaVersion: 1\nid: selection\nname: Selection\nworlds:\n  - path: worlds/watch\nplugins:\n  - path: plugins/checker\n",
    );
    write(
      "plugins/checker/PLUGIN.md",
      "---\ndescription: Static fixture\nprovides: [fixture-check@1]\nentry: ./index.js\n---\n",
    );
    write(
      "plugins/checker/index.js",
      `throw new Error("Preview must not execute entry code");`,
    );
    write("worlds/watch/WORLD.md", "Keep watch.");
    const manifest = (plugins) =>
      JSON.stringify({
        name: "Watch",
        summary: "Keep watch.",
        defaultLocale: "en-US",
        plugins,
      });
    write(
      "worlds/watch/world.yaml",
      manifest([
        "pack:unavailable",
        "plugin:missing",
        "contract:fixture-check@1",
      ]),
    );
    const result = run();
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /unknown-pack at plugins\[0\]/);
    assert.match(result.stderr, /requests plugin missing/);
    assert.doesNotMatch(
      result.stderr,
      /no installed or included plugin provides/,
    );
    assert.equal(existsSync(path.join(dir, "entry-ran")), false);

    write("worlds/watch/world.yaml", manifest(["plugin:valid", "bare"]));
    const malformed = run();
    assert.equal(
      malformed.status,
      1,
      malformed.error?.message ?? malformed.stderr,
    );
    assert.match(malformed.stderr, /plugins\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
