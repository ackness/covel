import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, shouldPromptForUpdate } from "./app-update.js";
import {
  readIgnoredUpdateVersion,
  writeIgnoredUpdateVersion,
} from "./app-update-state.js";

assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.1"), 1);
assert.equal(compareVersions("1.2.3", "1.2.3-beta.2"), 1);
assert.equal(compareVersions("1.2.3-beta", "1.2.3"), -1);
assert.equal(
  compareVersions("99999999999999999999.0.0", "99999999999999999998.0.0"),
  1,
);
assert.equal(compareVersions("1.02.3", "1.2.3"), null);
assert.equal(compareVersions("not-a-version", "1.2.3"), null);

assert.equal(shouldPromptForUpdate("0.0.28", "0.0.29", undefined), true);
assert.equal(shouldPromptForUpdate("0.0.29-dev", "0.0.29", undefined), true);
assert.equal(shouldPromptForUpdate("0.0.29", "0.0.29", undefined), false);
assert.equal(shouldPromptForUpdate("0.0.30", "0.0.29", undefined), false);
assert.equal(shouldPromptForUpdate("0.0.28", "0.0.29", "0.0.29"), false);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-app-update-"));
const stateFile = path.join(tempRoot, "app-update.json");
try {
  assert.equal(readIgnoredUpdateVersion(stateFile), undefined);
  writeIgnoredUpdateVersion(stateFile, "0.0.29");
  assert.equal(readIgnoredUpdateVersion(stateFile), "0.0.29");
  assert.throws(
    () => writeIgnoredUpdateVersion(stateFile, "invalid"),
    /valid SemVer/,
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.endsWith(".tmp")),
    [],
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("app-update selfcheck: OK");
