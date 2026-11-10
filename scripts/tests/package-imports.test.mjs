import { test } from "node:test";
import assert from "node:assert/strict";
import { packageImports } from "../lib/package-imports.mjs";

test("distinguishes type-only imports from mixed and dynamic imports", () => {
  assert.deepEqual(
    packageImports(
      "fixture.ts",
      `
    import type { DataStore } from "@covel/store";
    import { type VectorStore } from "@covel/store/vector";
    import { type Config, createStore } from "@covel/store/factory";
    type Result = import("@covel/shared").RuntimeResult;
    const load = () => import("@covel/store/sqlite");
  `,
    ).sort((a, b) => a.specifier.localeCompare(b.specifier)),
    [
      { specifier: "@covel/shared", typeOnly: true },
      { specifier: "@covel/store", typeOnly: true },
      { specifier: "@covel/store/factory", typeOnly: false },
      { specifier: "@covel/store/sqlite", typeOnly: false },
      { specifier: "@covel/store/vector", typeOnly: true },
    ],
  );
});
test("ignores documentation and string examples while checking re-exports", () => {
  assert.deepEqual(
    packageImports(
      "fixture.js",
      `
    /** @type {import('@covel/runtime').TurnResult} */
    const example = "import { fake } from '@covel/store'";
    export { value } from "@covel/shared";
  `,
    ),
    [{ specifier: "@covel/shared", typeOnly: false }],
  );
});
test("reports Vitest module mocks only when asked", () => {
  const source = `
    import { fn } from "./local.js";
    vi.mock("../../other/src/module.js", () => ({}));
    vi.doMock("./later.js");
    const actual = await vi.importActual("@covel/shared");
    other.mock("./not-vitest.js");
  `;
  assert.deepEqual(packageImports("fixture.ts", source), [
    { specifier: "./local.js", typeOnly: false },
  ]);
  assert.deepEqual(
    packageImports("fixture.ts", source, { mocks: true })
      .map(({ specifier, mock }) => `${specifier}${mock ? " (mock)" : ""}`)
      .sort(),
    [
      "../../other/src/module.js (mock)",
      "./later.js (mock)",
      "./local.js",
      "@covel/shared (mock)",
    ],
  );
});
