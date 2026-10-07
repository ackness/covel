import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadChildEnvironment,
  loadKeysEnv,
  patchKeysEnv,
  saveKeysEnv,
} from "./env-files.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-keys-check-"));
const file = path.join(root, "keys.env");
try {
  fs.writeFileSync(
    path.join(root, ".env"),
    "OPENAI_API_KEY=synthetic-env\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, ".env.llm"),
    "OPENAI_API_KEY=synthetic-llm\n",
    "utf8",
  );
  saveKeysEnv(file, { openai: "synthetic-home" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(
    loadChildEnvironment(root, file, {}).OPENAI_API_KEY,
    "synthetic-llm",
  );
  assert.equal(
    loadChildEnvironment(root, file, { OPENAI_API_KEY: "synthetic-shell" })
      .OPENAI_API_KEY,
    "synthetic-shell",
  );
  assert.equal(
    loadChildEnvironment(root, file, { OPENAI_API_KEY: undefined })
      .OPENAI_API_KEY,
    "synthetic-llm",
  );
  fs.unlinkSync(path.join(root, ".env.llm"));
  assert.equal(
    loadChildEnvironment(root, file, {}).OPENAI_API_KEY,
    "synthetic-env",
  );
  fs.unlinkSync(path.join(root, ".env"));
  assert.equal(
    loadChildEnvironment(root, file, {}).OPENAI_API_KEY,
    "synthetic-home",
  );
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

for (const fault of ["partial-write", "rename", "chmod"] as const) {
  test(`F-001: ${fault} failure preserves every existing key`, (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "covel-keys-fault-"),
    );
    const keysFile = path.join(directory, "keys.env");
    const originalKeys = {
      openai: "synthetic-retained",
      deepseek: "synthetic-original",
    };
    const error = new Error(`synthetic ${fault} failure`);
    try {
      saveKeysEnv(keysFile, originalKeys);
      const originalBytes = fs.readFileSync(keysFile);
      const writeFile = fs.writeFileSync;
      if (fault === "partial-write") {
        t.mock.method(
          fs,
          "writeFileSync",
          (
            ...[filename, body, options]: Parameters<typeof fs.writeFileSync>
          ) => {
            // Actually truncate/write a prefix before throwing, rather than
            // failing before any bytes reach the real filesystem.
            writeFile(
              filename,
              Buffer.from(String(body)).subarray(0, 12),
              options,
            );
            throw error;
          },
        );
      } else if (fault === "rename") {
        t.mock.method(fs, "renameSync", () => {
          throw error;
        });
      } else {
        t.mock.method(fs, "chmodSync", () => {
          throw error;
        });
      }
      assert.throws(
        () => patchKeysEnv(keysFile, { deepseek: "synthetic-replacement" }),
        (caught: unknown) => caught === error,
        "the original filesystem error must propagate",
      );
      assert.deepEqual(
        fs.readFileSync(keysFile),
        originalBytes,
        "failed save must leave the original bytes intact",
      );
      assert.deepEqual(loadKeysEnv(keysFile), originalKeys);
      assert.deepEqual(
        fs.readdirSync(directory),
        ["keys.env"],
        "failed save must remove its temporary file",
      );
    } finally {
      t.mock.restoreAll();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("F-001: successful replacement is private before publication", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "covel-keys-publish-"),
  );
  const keysFile = path.join(directory, "keys.env");
  try {
    fs.writeFileSync(keysFile, "OPENAI_API_KEY=synthetic-retained\n", {
      mode: 0o644,
    });
    const rename = fs.renameSync;
    const write = fs.writeFileSync;
    const chmod = fs.chmodSync;
    let temporaryFile: string | undefined;
    let publications = 0;
    let permissionUpdates = 0;
    t.mock.method(
      fs,
      "writeFileSync",
      (...[filename, body, options]: Parameters<typeof fs.writeFileSync>) => {
        assert.notEqual(
          filename,
          keysFile,
          "never truncate the live keys file",
        );
        assert.equal(path.dirname(String(filename)), directory);
        assert.deepEqual(options, { mode: 0o600, flag: "wx" });
        temporaryFile = String(filename);
        write(filename, body, options);
      },
    );
    t.mock.method(fs, "chmodSync", (filename: fs.PathLike, mode: fs.Mode) => {
      assert.equal(String(filename), temporaryFile);
      assert.equal(mode, 0o600);
      assert.equal(
        publications,
        0,
        "no required permission work after publication",
      );
      permissionUpdates++;
      chmod(filename, mode);
    });
    t.mock.method(
      fs,
      "renameSync",
      (source: fs.PathLike, destination: fs.PathLike) => {
        assert.equal(String(source), temporaryFile);
        assert.equal(destination, keysFile);
        assert.deepEqual(loadKeysEnv(keysFile), {
          openai: "synthetic-retained",
        });
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(source).mode & 0o777, 0o600);
        }
        publications++;
        rename(source, destination);
      },
    );
    patchKeysEnv(keysFile, { deepseek: "synthetic-added" });
    assert.equal(publications, 1);
    assert.equal(permissionUpdates, 1);
    assert.deepEqual(loadKeysEnv(keysFile), {
      openai: "synthetic-retained",
      deepseek: "synthetic-added",
    });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(keysFile).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(directory), ["keys.env"]);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
