import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import config from "../../apps/docs/.vitepress/config.ts";
import { assembleRelease } from "../lib/changelog-fragments.mjs";

const docsRequire = createRequire(
  new URL("../../apps/docs/package.json", import.meta.url),
);
const { createMarkdownRenderer } = await import(
  docsRequire.resolve("vitepress")
);

test("the docs renderer resolves assembled CHANGELOG links from docs on the included release page", async () => {
  const md = await createMarkdownRenderer(
    fileURLToPath(new URL("../../docs/", import.meta.url)),
    config.markdown,
  );
  const { text } = assembleRelease(
    "# Changelog\n\n## [Unreleased]\n",
    [
      {
        name: "links.md",
        text: "### Fixed\n\n- **Links work.** [slots](../reference/slots.md#models), [English](../en/plugins/testing.md#validation), [source](../../scripts/changelog.mjs), [anchor](#part), [web](https://example.com/guide).\n",
      },
    ],
    { version: "0.2.0", date: "2026-02-03" },
  );
  const html = md.render(text, { relativePath: "en/releases.md" });
  assert.ok(html.includes('href="./../reference/slots.html#models"'), html);
  assert.ok(html.includes('href="./plugins/testing.html#validation"'), html);
  assert.ok(
    html.includes(
      'href="https://github.com/ackness/covel/blob/main/scripts/changelog.mjs"',
    ),
    html,
  );
  assert.ok(html.includes('href="#part"'), html);
  assert.ok(html.includes('href="https://example.com/guide"'), html);
});
