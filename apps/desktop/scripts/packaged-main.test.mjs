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

async function fixture(
  t,
  {
    main = currentMain,
    entry = "dist/main.mjs",
    unpack = false,
    omitMain = false,
    linkMain = false,
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
  const archive = path.join(resources, "app.asar");
  await asar.createPackageWithOptions(
    application,
    archive,
    unpack ? { unpack: "**/main.mjs" } : {},
  );
  return { root, resources, application, archive };
}

test("release verification hashes the packaged ASAR main, never a source dist lookalike", async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => verifyPackagedMain(f.resources, hash(currentMain)));
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
    () => verifyPackagedMain(f.resources, hash(currentMain)),
    /Packaged main SHA256 mismatch/,
  );
  // Replacing an already-read archive must invalidate upstream header caching.
  fs.writeFileSync(path.join(f.application, "dist/main.mjs"), currentMain);
  await asar.createPackage(f.application, f.archive);
  assert.doesNotThrow(() => verifyPackagedMain(f.resources, hash(currentMain)));
});

test("missing, unpacked, redirected and nonregular application entries fail closed", async (t) => {
  const missingMain = await fixture(t, { omitMain: true });
  assert.throws(() =>
    verifyPackagedMain(missingMain.resources, hash(currentMain)),
  );
  const unpacked = await fixture(t, { unpack: true });
  assert.throws(
    () => verifyPackagedMain(unpacked.resources, hash(currentMain)),
    /packed regular file/,
  );
  const redirected = await fixture(t, { entry: "dist/other-main.mjs" });
  assert.throws(
    () => verifyPackagedMain(redirected.resources, hash(currentMain)),
    /Unexpected packaged application main entry/,
  );
  const missingArchive = await fixture(t);
  fs.unlinkSync(missingArchive.archive);
  assert.throws(
    () => verifyPackagedMain(missingArchive.resources, hash(currentMain)),
    /ENOENT/,
  );
  fs.mkdirSync(missingArchive.archive);
  assert.throws(
    () => verifyPackagedMain(missingArchive.resources, hash(currentMain)),
    /archive must be a regular file/,
  );
  if (process.platform !== "win32") {
    const linked = await fixture(t, { linkMain: true });
    assert.throws(
      () => verifyPackagedMain(linked.resources, hash(currentMain)),
      /packed regular file/,
    );
    const linkedArchive = await fixture(t);
    fs.renameSync(linkedArchive.archive, `${linkedArchive.archive}.original`);
    fs.symlinkSync(`${linkedArchive.archive}.original`, linkedArchive.archive);
    assert.throws(
      () => verifyPackagedMain(linkedArchive.resources, hash(currentMain)),
      /archive must be a regular file/,
    );
  }
});

test("release smoke rejects mismatched packaged main before probing a runtime or starting the backend", async (t) => {
  const f = await fixture(t, { main: "// altered packaged main\n" });
  fs.writeFileSync(
    path.join(f.resources, "runtime-selection.json"),
    JSON.stringify({
      mode: BACKEND_RUNTIME_MODE,
      selection: RUNTIME_SELECTION_ID,
      mainSha256: hash(currentMain),
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
