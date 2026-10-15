import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkSessionWorldText,
  sessionWorldTextProblems,
} from "../check-session-world-text.mjs";

test("session world labels select an edition", () => {
  assert.deepEqual(checkSessionWorldText(), []);
});

test("catches raw display fields including optional and bracket access", () => {
  for (const expression of [
    "text(world?.name)",
    "resolveI18n(world.description, locale)",
    'world["name"]',
    "state.world.name",
  ]) {
    assert.equal(
      sessionWorldTextProblems("fixture.tsx", `const label = ${expression};`)
        .length,
      1,
      expression,
    );
  }
});

test("accepts edition helpers and ignores comments and translation keys", () => {
  assert.deepEqual(
    sessionWorldTextProblems(
      "fixture.tsx",
      `// world.name
       const title = worldDisplayText(world, session.locale).name;
       const document = localizedWorldText({ description: text(world.description) }, locale);
       const label = t("world.name");`,
    ),
    [],
  );
});
