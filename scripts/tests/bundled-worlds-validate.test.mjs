import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every bundled world must pass `pnpm validate:world --strict` on ordinary CI,
// not only in the release preflight. A plugin schema, manifest or setting change
// then fails here instead of at release time.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLED_WORLDS = [
  "emberback",
  "haruka-academy",
  "lantern-barrow",
  "mistport",
];

test("the four bundled worlds pass validate:world --strict", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/validate-release-worlds.ts",
      "--strict",
      ...BUNDLED_WORLDS.map((id) => `worlds/${id}`),
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 540_000 },
  );
  assert.equal(
    result.status,
    0,
    `validate:world --strict failed:\n${result.stdout}\n${result.stderr}`,
  );
  for (const id of BUNDLED_WORLDS) {
    assert.match(result.stdout, new RegExp(`✓ worlds/${id}/world\\.yaml`));
  }
});
