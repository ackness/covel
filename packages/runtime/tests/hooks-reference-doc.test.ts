import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { HOOK_EVENTS } from "@covel/shared";
import {
  GUARD_FAILURE_SCOPE,
  GUARD_HOOK_EVENTS,
  HOOK_SEMANTICS,
} from "../src/hooks/types.js";

const page = readFileSync(
  resolve(import.meta.dirname, "../../../docs/reference/hooks.md"),
  "utf8",
);
const englishPage = readFileSync(
  resolve(import.meta.dirname, "../../../docs/en/reference/hooks.md"),
  "utf8",
);
const pages = [page, englishPage];

it("the hooks reference lists every event as the pipeline runs it", () => {
  const rows = [
    ...page.matchAll(/^\| `(\w+)`\s*\| (\w+)\s*\| (\w+)\s*\| (\w+)/gm),
  ]
    .filter(([, name]) => (HOOK_EVENTS as readonly string[]).includes(name!))
    .map(([, name, , runs, guard]) => ({ name, runs, guard }));
  expect(rows).toEqual(
    HOOK_EVENTS.map((name) => ({
      name,
      runs: HOOK_SEMANTICS[name],
      guard: GUARD_HOOK_EVENTS.has(name) ? "yes" : "no",
    })),
  );
  // Each event has its own section, and no section names an event that is gone.
  expect([...page.matchAll(/^### `(\w+)`$/gm)].map(([, name]) => name)).toEqual(
    [...HOOK_EVENTS],
  );
});

it.each(pages.map((text, index) => [index === 0 ? "zh" : "en", text]))(
  "the %s hooks reference gives each guard event its failure scope",
  (_language, text) => {
    const rows = [
      ...text.matchAll(
        /^\| `(\w+)` \| `(own-runtimes|own-subject|closed)` \|/gm,
      ),
    ].map(([, name, scope]) => [name, scope]);
    expect(rows).toEqual(
      HOOK_EVENTS.filter((name) => GUARD_HOOK_EVENTS.has(name)).map((name) => [
        name,
        GUARD_FAILURE_SCOPE[name],
      ]),
    );
  },
);
