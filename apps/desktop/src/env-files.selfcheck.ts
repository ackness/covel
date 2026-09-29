import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKeysEnv, patchKeysEnv, saveKeysEnv } from "./env-files.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-keys-check-"));
const file = path.join(root, "keys.env");
try {
  saveKeysEnv(file, { deepseek: "synthetic-original" });
  const original = fs.readFileSync(file, "utf8");
  for (const value of ["bad\nvalue", "bad\rvalue"]) {
    assert.throws(
      () => saveKeysEnv(file, { deepseek: "synthetic-new", other: value }),
      /single-line/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(loadKeysEnv(file), { deepseek: "synthetic-original" });
  }
  patchKeysEnv(file, { other: "synthetic-other" });
  patchKeysEnv(file, { DEEPSEEK_API_KEY: "synthetic-next" });
  assert.deepEqual(loadKeysEnv(file), {
    deepseek: "synthetic-next",
    other: "synthetic-other",
  });
  patchKeysEnv(file, { deepseek: null });
  assert.deepEqual(loadKeysEnv(file), { other: "synthetic-other" });
  patchKeysEnv(file, {});
  assert.deepEqual(loadKeysEnv(file), { other: "synthetic-other" });
  const beforeInvalidPatch = fs.readFileSync(file, "utf8");
  assert.throws(
    () => patchKeysEnv(file, { other: null, bad: "bad\nvalue" }),
    /single-line/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), beforeInvalidPatch);
  const unreadable = path.join(root, "unreadable");
  fs.mkdirSync(unreadable);
  assert.throws(() => patchKeysEnv(unreadable, {}));
  console.log("env-files selfcheck: OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
