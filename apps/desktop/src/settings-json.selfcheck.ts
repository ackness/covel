import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSettingsBundle,
  writeSettingsEntriesAtomic,
} from "./settings-json.js";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "covel-settings-check-"),
);
const settingsFile = path.join(tempRoot, "settings.json");

function assertRejectsInvalidSettings(contents: string, label: string): void {
  fs.writeFileSync(settingsFile, contents, "utf-8");
  assert.throws(
    () => readSettingsBundle(settingsFile),
    /settings|JSON/i,
    label,
  );
}

try {
  // Fresh installs have no settings.json and must hydrate as an empty map.
  assert.deepEqual(readSettingsBundle(settingsFile).entries, {});

  // Existing invalid JSON and invalid/missing entries must not become an empty
  // snapshot that SettingsStore could later write back over the source file.
  assertRejectsInvalidSettings("{", "corrupt JSON load");
  assertRejectsInvalidSettings('{"entries":[]}', "array entries load");
  assertRejectsInvalidSettings("{}", "missing entries load");

  // A sidecar-save failure may use the local fallback only for an intact
  // existing bundle; preserve corrupt input byte-for-byte by refusing it.
  const corrupt = '{"entries":';
  fs.writeFileSync(settingsFile, corrupt, "utf-8");
  assert.throws(
    () => writeSettingsEntriesAtomic(settingsFile, { "ui.locale": "zh-CN" }),
    /settings|JSON|Expected/i,
    "corrupt settings save is rejected",
  );
  assert.equal(fs.readFileSync(settingsFile, "utf-8"), corrupt);

  // A valid local fallback replaces the full bundle using a same-directory
  // temporary file and leaves a 0600 settings.json with the new entries.
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: "old",
      entries: { old: true },
    }),
    { mode: 0o644 },
  );
  assert.deepEqual(readSettingsBundle(settingsFile).entries, { old: true });
  const written = writeSettingsEntriesAtomic(
    settingsFile,
    { "ui.locale": "en-US" },
    0,
  );
  assert.equal(written.revision, 1);
  const saved = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as {
    schemaVersion: number;
    revision: number;
    savedAt: string;
    entries: Record<string, unknown>;
  };
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.revision, 1);
  assert.match(saved.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(saved.entries, { "ui.locale": "en-US" });
  const savedBytes = fs.readFileSync(settingsFile, "utf-8");
  assert.throws(
    () => writeSettingsEntriesAtomic(settingsFile, { "ui.locale": "zh-CN" }, 0),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "settings_revision_conflict" &&
      (error as { revision?: unknown }).revision === 1,
    "stale local fallback save is rejected",
  );
  assert.equal(
    fs.readFileSync(settingsFile, "utf-8"),
    savedBytes,
    "revision conflict leaves settings.json byte-for-byte unchanged",
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  }
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name.endsWith(".tmp")),
    [],
    "atomic save cleans up its same-directory temporary file",
  );

  console.log("settings-json selfcheck: OK");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
