import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKeysEnv, saveKeysEnv } from "./env-files.js";

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
  console.log("env-files selfcheck: OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
