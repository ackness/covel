import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoPrivateConfig } from "./private-config.mjs";

test("staging and installer validation reject private configuration without exposing values", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-package-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of [
    "llm.toml",
    "llm.toml.smoke-hidden",
    "keys.env",
    "config.toml",
    ".env",
    ".env.llm",
  ]) {
    fs.writeFileSync(path.join(dir, name), "synthetic-private-value", "utf-8");
    assert.throws(
      () => assertNoPrivateConfig(dir),
      (error) => {
        assert.match(
          error.message,
          /Private configuration must not be packaged/,
        );
        assert.ok(error.message.includes(name));
        assert.ok(!error.message.includes("synthetic-private-value"));
        return true;
      },
    );
    fs.unlinkSync(path.join(dir, name));
  }
});

test("runtime resources and plugin-owned configuration remain allowed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-package-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "plugins", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf-8");
  fs.writeFileSync(
    path.join(dir, "plugins", "fixture", "llm.toml"),
    "",
    "utf-8",
  );
  assert.doesNotThrow(() => assertNoPrivateConfig(dir));
});
