import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detachStagingHardlinks } from "./staging-files.mjs";

test("staging cache restores cannot overwrite workspace files or the package store", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-stage-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.mjs");
  const staging = path.join(root, "staging");
  const nested = path.join(staging, "node_modules", "runtime");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(source, "original", { encoding: "utf8", mode: 0o755 });
  const artifact = path.join(nested, "source.mjs");
  fs.linkSync(source, artifact);
  const binary = path.join(staging, "native.bin");
  const sharedBinary = path.join(root, "store.bin");
  fs.writeFileSync(sharedBinary, Buffer.from([0, 1, 255]));
  fs.linkSync(sharedBinary, binary);

  assert.equal(detachStagingHardlinks(staging), 2);
  assert.equal(detachStagingHardlinks(staging), 0);
  assert.equal(fs.readFileSync(artifact, "utf8"), "original");
  assert.deepEqual(fs.readFileSync(binary), Buffer.from([0, 1, 255]));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(artifact).mode & 0o777, 0o755);
  }

  fs.writeFileSync(source, "edited workspace", "utf8");
  assert.equal(fs.readFileSync(artifact, "utf8"), "original");
  // Simulate an in-place Turbo cache extraction onto the existing artifact.
  fs.writeFileSync(artifact, "cached artifact", "utf8");
  fs.writeFileSync(binary, Buffer.from([42]));
  assert.equal(fs.readFileSync(source, "utf8"), "edited workspace");
  assert.deepEqual(fs.readFileSync(sharedBinary), Buffer.from([0, 1, 255]));
});
