import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkPluginEventSchemas } from "../lib/plugin-event-schemas.mjs";

async function fixture(t, schema) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "covel-event-schema-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "schemas"));
  await fs.writeFile(
    path.join(root, "PLUGIN.md"),
    `---\ncontributes:\n  events:\n    - topic: test.event\n      schema: ./schemas/event.json\n---\n`,
  );
  if (schema !== undefined)
    await fs.writeFile(path.join(root, "schemas/event.json"), schema);
  return root;
}

test("validates root events once regardless of runtime and locale manifests", async (t) => {
  const root = await fixture(t, '{"type":"object"}');
  await fs.mkdir(path.join(root, "runtimes/run"), { recursive: true });
  await fs.writeFile(
    path.join(root, "runtimes/run/RUNTIME.md"),
    "---\ntype: function\n---\n",
  );
  await fs.copyFile(
    path.join(root, "PLUGIN.md"),
    path.join(root, "PLUGIN.en.md"),
  );
  assert.deepEqual(checkPluginEventSchemas(root), { checked: 1, errors: [] });
});
for (const [name, value, message] of [
  ["missing file", undefined, /cannot read JSON schema/],
  ["invalid JSON", "{broken", /cannot read JSON schema/],
  ["invalid schema shape", "{}", /must contain type or properties/],
])
  test(`rejects ${name} in contributes.events`, async (t) => {
    const result = checkPluginEventSchemas(await fixture(t, value));
    assert.equal(result.checked, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], message);
  });
