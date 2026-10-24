import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectResourceDirs,
  resolveReleaseTarget,
} from "./verify-release.mjs";
import {
  BACKEND_RUNTIME_MODE,
  RUNTIME_SELECTION_ID,
} from "../src/backend-runtime.ts";

function fixture(t, directory, platform, arch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-release-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(
    root,
    directory,
    platform === "darwin" ? "Covel.app/Contents/Resources" : "resources",
  );
  fs.mkdirSync(resources, { recursive: true });
  const metadata = {
    mode: BACKEND_RUNTIME_MODE,
    selection: RUNTIME_SELECTION_ID,
    mainSha256: "a".repeat(64),
    preloadSha256: "b".repeat(64),
    platform,
    arch,
  };
  const file = path.join(resources, "runtime-selection.json");
  fs.writeFileSync(file, JSON.stringify(metadata));
  return { root, resources, metadata, file };
}

test("architectureless release directories use validated target metadata, including mac arm64", (t) => {
  for (const [directory, family, platform, arch] of [
    ["mac", "mac", "darwin", "arm64"],
    ["mac-arm64", "mac", "darwin", "arm64"],
    ["win-unpacked", "win", "win32", "x64"],
    ["linux-unpacked", "linux", "linux", "arm64"],
    ["linux-unpacked", "linux", "linux", "x64"],
    ["linux-arm64-unpacked", "linux", "linux", "arm64"],
  ]) {
    const f = fixture(t, directory, platform, arch);
    assert.deepEqual(collectResourceDirs(f.root, family), [
      { resourcesDir: f.resources, platform, arch },
    ]);
  }
});

test("release targets fail closed on missing, invalid, unsupported or conflicting metadata", (t) => {
  const f = fixture(t, "linux-arm64-unpacked", "linux", "arm64");
  for (const patch of [
    { arch: undefined },
    { arch: null },
    { arch: "ia32" },
    { arch: "x64" },
    { platform: "darwin" },
    { selection: "old" },
    { preloadSha256: undefined },
  ]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.metadata, ...patch }));
    assert.throws(() => collectResourceDirs(f.root, "linux"));
  }
  fs.writeFileSync(
    f.file,
    JSON.stringify({ ...f.metadata, platform: "darwin", arch: "x64" }),
  );
  assert.throws(
    () => resolveReleaseTarget(f.resources, "mac"),
    /Unsupported desktop runtime target/,
  );
  fs.unlinkSync(f.file);
  assert.throws(() => resolveReleaseTarget(f.resources, "linux"), /ENOENT/);
  if (process.platform !== "win32") {
    fs.writeFileSync(`${f.file}.original`, JSON.stringify(f.metadata));
    fs.symlinkSync(`${f.file}.original`, f.file);
    assert.throws(
      () => resolveReleaseTarget(f.resources, "linux"),
      /regular file/,
    );
  }
});
