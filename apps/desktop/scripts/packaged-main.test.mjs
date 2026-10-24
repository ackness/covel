import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as asar from "@electron/asar";
import {
  BACKEND_RUNTIME_MODE,
  RUNTIME_SELECTION_ID,
} from "../src/backend-runtime.ts";
import { verifyPackagedMain } from "./packaged-main.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const currentMain =
  "// current bundled main\nexport const title = 'Covel 世界';\n";
const currentPreload = "// current bundled preload\n";
const selection = {
  mainSha256: hash(currentMain),
  preloadSha256: hash(currentPreload),
};

async function fixture(
  t,
  {
    main = currentMain,
    entry = "dist/main.mjs",
    unpack = false,
    omitMain = false,
    linkMain = false,
    preload = currentPreload,
    omitPreload = false,
    linkPreload = false,
    unpackPreload = false,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-packaged-main-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const application = path.join(root, "application");
  fs.mkdirSync(resources);
  fs.mkdirSync(path.join(application, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(application, "package.json"),
    JSON.stringify({ type: "module", main: entry }),
  );
  if (!omitMain) {
    if (linkMain) {
      fs.writeFileSync(path.join(application, "actual-main.mjs"), main);
      fs.symlinkSync(
        "../actual-main.mjs",
        path.join(application, "dist/main.mjs"),
      );
    } else {
      fs.writeFileSync(path.join(application, "dist/main.mjs"), main);
    }
  }
  if (!omitPreload) {
    if (linkPreload) {
      fs.writeFileSync(path.join(application, "actual-preload.mjs"), preload);
      fs.symlinkSync(
        "../actual-preload.mjs",
        path.join(application, "dist/preload.mjs"),
      );
    } else {
      fs.writeFileSync(path.join(application, "dist/preload.mjs"), preload);
    }
  }
  const archive = path.join(resources, "app.asar");
  await asar.createPackageWithOptions(
    application,
    archive,
    unpack
      ? { unpack: "**/main.mjs" }
      : unpackPreload
        ? { unpack: "**/preload.mjs" }
        : {},
  );
  return { root, resources, application, archive };
}

test("release verification hashes the packaged ASAR main, never a source dist lookalike", async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => verifyPackagedMain(f.resources, selection));
  // A matching checkout bundle must not bless stale packaged bytes.
  const sourceMain = path.join(f.root, "checkout/apps/desktop/dist/main.mjs");
  fs.mkdirSync(path.dirname(sourceMain), { recursive: true });
  fs.writeFileSync(sourceMain, currentMain);
  fs.writeFileSync(
    path.join(f.application, "dist/main.mjs"),
    "// stale packaged main\n",
  );
  await asar.createPackage(f.application, f.archive);
  assert.throws(
    () => verifyPackagedMain(f.resources, selection),
    /Packaged main SHA256 mismatch/,
  );
  // Replacing an already-read archive must invalidate upstream header caching.
  fs.writeFileSync(path.join(f.application, "dist/main.mjs"), currentMain);
  await asar.createPackage(f.application, f.archive);
  assert.doesNotThrow(() => verifyPackagedMain(f.resources, selection));
});

test("missing, unpacked, redirected and nonregular application entries fail closed", async (t) => {
  const missingMain = await fixture(t, { omitMain: true });
  assert.throws(() => verifyPackagedMain(missingMain.resources, selection));
  const unpacked = await fixture(t, { unpack: true });
  assert.throws(
    () => verifyPackagedMain(unpacked.resources, selection),
    /packed regular file/,
  );
  const redirected = await fixture(t, { entry: "dist/other-main.mjs" });
  assert.throws(
    () => verifyPackagedMain(redirected.resources, selection),
    /Unexpected packaged application main entry/,
  );
  const missingArchive = await fixture(t);
  fs.unlinkSync(missingArchive.archive);
  assert.throws(
    () => verifyPackagedMain(missingArchive.resources, selection),
    /ENOENT/,
  );
  fs.mkdirSync(missingArchive.archive);
  assert.throws(
    () => verifyPackagedMain(missingArchive.resources, selection),
    /archive must be a regular file/,
  );
  if (process.platform !== "win32") {
    const linked = await fixture(t, { linkMain: true });
    assert.throws(
      () => verifyPackagedMain(linked.resources, selection),
      /packed regular file/,
    );
    const linkedArchive = await fixture(t);
    fs.renameSync(linkedArchive.archive, `${linkedArchive.archive}.original`);
    fs.symlinkSync(`${linkedArchive.archive}.original`, linkedArchive.archive);
    assert.throws(
      () => verifyPackagedMain(linkedArchive.resources, selection),
      /archive must be a regular file/,
    );
  }
});

test("preload bytes and packed regular entries are mandatory, including after archive replacement", async (t) => {
  const f = await fixture(t);
  verifyPackagedMain(f.resources, selection);
  fs.writeFileSync(
    path.join(f.application, "dist/preload.mjs"),
    "// stale preload",
  );
  await asar.createPackage(f.application, f.archive);
  assert.throws(
    () => verifyPackagedMain(f.resources, selection),
    /Packaged preload SHA256 mismatch/,
  );
  fs.writeFileSync(
    path.join(f.application, "dist/preload.mjs"),
    currentPreload,
  );
  await asar.createPackage(f.application, f.archive);
  verifyPackagedMain(f.resources, selection);
  // Corrupt the actual payload without updating the ASAR header's integrity claim.
  const bytes = fs.readFileSync(f.archive);
  const offset = bytes.indexOf(Buffer.from(currentPreload));
  assert.ok(offset >= 0);
  bytes[offset] = 33;
  fs.writeFileSync(f.archive, bytes);
  assert.throws(
    () => verifyPackagedMain(f.resources, selection),
    /Packaged preload SHA256 mismatch/,
  );
  for (const options of [
    { omitPreload: true },
    { unpackPreload: true },
    ...(process.platform === "win32" ? [] : [{ linkPreload: true }]),
  ]) {
    const invalid = await fixture(t, options);
    assert.throws(() => verifyPackagedMain(invalid.resources, selection));
  }
});

test("release smoke rejects mismatched packaged preload before probing or starting the backend", async (t) => {
  const f = await fixture(t, { preload: "// altered packaged preload" });
  fs.writeFileSync(
    path.join(f.resources, "runtime-selection.json"),
    JSON.stringify({
      mode: BACKEND_RUNTIME_MODE,
      selection: RUNTIME_SELECTION_ID,
      ...selection,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./verify-staging.mjs", import.meta.url)),
      "--resources",
      f.resources,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Packaged preload SHA256 mismatch/);
  assert.doesNotMatch(result.stdout, /\[smoke\] spawning/);
});

test("release smoke rejects mismatched packaged main before probing a runtime or starting the backend", async (t) => {
  const f = await fixture(t, { main: "// altered packaged main\n" });
  fs.writeFileSync(
    path.join(f.resources, "runtime-selection.json"),
    JSON.stringify({
      mode: BACKEND_RUNTIME_MODE,
      selection: RUNTIME_SELECTION_ID,
      ...selection,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  // Deliberately provide no backend executable or server: the packaged-main
  // mismatch must be diagnosed before either could be touched or launched.
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./verify-staging.mjs", import.meta.url)),
      "--resources",
      f.resources,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Packaged main SHA256 mismatch/);
  assert.doesNotMatch(result.stdout, /\[smoke\] spawning/);
});
