import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoPluginLoadErrors } from "./plugin-load-check.mjs";

for (const failure of [
  'Error: [plugin-entry] plugins/fixture/PLUGIN.md: failed to activate entry "entry.js"',
  "Error [ERR_MODULE_NOT_FOUND]: Missing module",
  "Error: Cannot find package 'fixture'",
  "[bootstrap] Failed to load fixture",
  "[ui-specs] Failed to load runtime fixture",
]) {
  test(`rejects startup failure: ${failure}`, () => {
    // Exercise real stderr fragmentation, including inside the failure marker.
    for (let split = 1; split < failure.length; split++) {
      assert.throws(
        () =>
          assertNoPluginLoadErrors([
            "Startup begins\n",
            failure.slice(0, split),
            failure.slice(split),
            "\n    at syntheticFactory (entry.js:1:1)\nHealth ready\n",
          ]),
        /staged server logged plugin-load failures/,
      );
    }
  });
}

test("allows startup messages and recoverable registration warnings", () => {
  assert.doesNotThrow(() =>
    assertNoPluginLoadErrors([
      "[bootstrap] Loaded plugins\n",
      '[plugin-entry] fixture: registerRpc("duplicate") failed — already registered\n',
      "[plugin-entry] fixture: unknown hook event — skipping\n",
      "Health ready\n",
    ]),
  );
});
