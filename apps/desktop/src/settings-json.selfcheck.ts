import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveUnusableSettingsFile,
  backupSettingsFile,
  listSettingsBackups,
  readSettingsBackup,
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

  for (const schemaVersion of [undefined, 1]) {
    const contents = JSON.stringify({
      schemaVersion,
      entries: { retained: true },
    });
    assertRejectsInvalidSettings(contents, "unsupported settings version");
    assert.throws(
      () => writeSettingsEntriesAtomic(settingsFile, { replacement: true }),
      /unsupported settings schemaVersion/,
    );
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), contents);
  }

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
      schemaVersion: 2,
      revision: 0,
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

  // A file this build cannot use is moved aside, byte for byte, and the next
  // read is a fresh install.
  const olderBytes = JSON.stringify({
    schemaVersion: 1,
    savedAt: "2026-07-06T02:48:18.590Z",
    entries: { "ui.locale": "zh-CN" },
  });
  fs.writeFileSync(settingsFile, olderBytes, "utf-8");
  assert.equal(
    archiveUnusableSettingsFile(settingsFile),
    "settings.v1.bak.json",
  );
  assert.equal(
    fs.readFileSync(path.join(tempRoot, "settings.v1.bak.json"), "utf-8"),
    olderBytes,
  );
  assert.deepEqual(readSettingsBundle(settingsFile).entries, {});
  assert.equal(archiveUnusableSettingsFile(settingsFile), null, "missing file");

  fs.writeFileSync(settingsFile, olderBytes, "utf-8");
  const second = archiveUnusableSettingsFile(settingsFile);
  assert.match(second ?? "", /^settings\.v1\.\d+\.bak\.json$/);
  assert.equal(
    fs.readFileSync(path.join(tempRoot, "settings.v1.bak.json"), "utf-8"),
    olderBytes,
    "an earlier backup is not written over",
  );

  for (const [contents, backup] of [
    [
      JSON.stringify({ entries: { old: true } }),
      "settings.unversioned.bak.json",
    ],
    ["{ not json", "settings.damaged.bak.json"],
  ] as const) {
    fs.writeFileSync(settingsFile, contents, "utf-8");
    assert.equal(archiveUnusableSettingsFile(settingsFile), backup);
    assert.equal(
      fs.readFileSync(path.join(tempRoot, backup), "utf-8"),
      contents,
    );
  }

  // A file this build reads and a file from a later build stay where they are.
  for (const kept of [
    JSON.stringify({ schemaVersion: 2, revision: 3, savedAt: "", entries: {} }),
    JSON.stringify({ schemaVersion: 3, entries: {} }),
  ]) {
    fs.writeFileSync(settingsFile, kept, "utf-8");
    assert.equal(archiveUnusableSettingsFile(settingsFile), null);
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), kept);
  }

  // A copy for values the settings now refuse: the file itself stays, the
  // copy is listed, and only a listed name can be read.
  const current = JSON.stringify({
    schemaVersion: 2,
    revision: 3,
    savedAt: "",
    entries: { "ui.appearance": "retired-theme" },
  });
  fs.writeFileSync(settingsFile, current, "utf-8");
  assert.equal(backupSettingsFile(settingsFile), "settings.conflict.bak.json");
  assert.equal(fs.readFileSync(settingsFile, "utf-8"), current);
  assert.ok(
    listSettingsBackups(settingsFile).includes("settings.conflict.bak.json"),
  );
  assert.equal(
    readSettingsBackup(settingsFile, "settings.conflict.bak.json"),
    current,
  );
  assert.equal(readSettingsBackup(settingsFile, "settings.json"), null);
  assert.equal(readSettingsBackup(settingsFile, "../settings.json"), null);

  // Repeated archive/copy operations can share a millisecond. Each one must
  // retain its own original bytes rather than replacing an earlier backup.
  const originalNow = Date.now;
  Date.now = () => 123;
  try {
    for (const archive of [true, false]) {
      const names: string[] = [];
      const contents: string[] = [];
      for (let index = 0; index < 3; index++) {
        const bytes = JSON.stringify({ schemaVersion: 1, entries: { index } });
        fs.writeFileSync(settingsFile, bytes, "utf-8");
        names.push(
          archive
            ? archiveUnusableSettingsFile(settingsFile)!
            : backupSettingsFile(settingsFile, "repeat"),
        );
        contents.push(bytes);
      }
      assert.equal(new Set(names).size, 3);
      assert.deepEqual(
        names.map((name) => readSettingsBackup(settingsFile, name)),
        contents,
      );
    }
  } finally {
    Date.now = originalNow;
  }

  console.log("settings-json selfcheck: OK");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
