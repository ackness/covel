// Documentation references must match source: locale filenames, store APIs,
// json-render registrations, and backticked API names in both editions.
import { test } from "node:test";
import { sourceFiles } from "../lib/package-exports.mjs";
import {
  apiReferences,
  catalogNames,
  componentReferences,
  missingReferences,
  sourceNames,
  specComponentReferences,
} from "../lib/doc-references.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function filesUnder(directory, extension) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory())
      found.push(...filesUnder(full, extension));
    else if (name.endsWith(extension)) found.push(full);
  }
  return found;
}

test("world files in docs code blocks name the locale exactly, not a bare language", () => {
  // The loader ignores a world file named with a bare language, so a code
  // block that shows one teaches the wrong name.
  // Only real language codes count: `world.ir.yaml` is a file name, not a locale.
  const bare =
    /\b(WORLD|world)\.(en|zh|ja|ko|ru|fr|de|es|pt|it|ar|th|vi|tr|nl|pl|uk|hi)\.(md|ya?ml|json)\b/;
  const problems = [];
  for (const file of filesUnder(path.join(root, "docs"), ".md")) {
    const text = readFileSync(file, "utf8");
    for (const block of text.match(/```[\s\S]*?```/g) ?? []) {
      for (const line of block.split("\n")) {
        if (bare.test(line))
          problems.push(`${path.relative(root, file)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("store methods named in transactions.md exist in the store package", () => {
  // A method is declared as a function, a const, or a class member.
  const declaration =
    /(?:function\s+|^\s*(?:async\s+)?|const\s+)((?:list|get)[A-Z]\w*)\s*[(<:=]/gm;
  const declared = new Set();
  for (const file of filesUnder(path.join(root, "packages/store/src"), ".ts")) {
    if (file.endsWith(".test.ts")) continue;
    for (const match of readFileSync(file, "utf8").matchAll(declaration)) {
      declared.add(match[1]);
    }
  }
  const problems = [];
  for (const page of [
    "docs/reference/transactions.md",
    "docs/en/reference/transactions.md",
  ]) {
    const text = readFileSync(path.join(root, page), "utf8");
    for (const match of text.matchAll(/`((?:list|get)[A-Z]\w*)\(/g)) {
      if (!declared.has(match[1]))
        problems.push(`${page}: \`${match[1]}(\` is not a store method`);
    }
  }
  assert.deepEqual(problems, []);
});

// Keep names in prose and examples tied to registrations and declarations,
// without importing the browser application or executing plugin code.

const nonCatalogNames = {
  MediaPreviewDialog: "Internal React media preview, not a spec component.",
  BookOpen: "Lucide icon name.",
  HelpCircle: "Lucide icon name.",
  AssetGenerateView: "Proposal view type.",
  GameView: "Internal React game screen.",
  SessionDimensionsPanel: "Internal React dimensions panel.",
  WorldRecord: "World data type.",
  PluginPanel: "Internal React spec host.",
  Label: "Translatable property-name suffix.",
  Title: "Translatable property-name suffix.",
  Message: "Translatable property-name suffix.",
  Placeholder: "Translatable property-name suffix.",
  Description: "Translatable property-name suffix.",
  Hint: "Translatable property-name suffix.",
  Tooltip: "Translatable property-name suffix.",
  Codex: "Example label being translated.",
  I18nText: "Localized text type.",
  MessageBlockRenderer: "Internal React message host.",
  GameViewHeader: "Internal React header.",
  ChatMessages: "Internal React message list.",
  PendingDraftsBar: "Internal React draft bar.",
  MessageComposer: "Internal React message composer.",
  StageDialog: "Internal React stage dialog.",
  MediaRef: "Media reference type.",
  Dialog: "Internal React dialog primitive.",
  DimensionValueEditor: "Internal React dimension editor.",
  Kard: "Deliberately misspelled Card in the validation-error walkthrough.",
};

test("json-render component names in both editions exist in the web catalog", () => {
  const known = catalogNames(
    readFileSync(path.join(root, "apps/web/src/lib/catalog.tsx"), "utf8"),
  );
  const problems = [];
  for (const edition of ["docs", "docs/en"]) {
    for (const page of [
      "reference/ui-components.md",
      "reference/ui-panels.md",
      "plugins/ui.md",
    ]) {
      const file = `${edition}/${page}`;
      const text = readFileSync(path.join(root, file), "utf8");
      // A prose exception (e.g. the internal Dialog) cannot authorize that
      // name in an actual spec's component/type field.
      const missing = new Set([
        ...missingReferences(specComponentReferences(text), known),
        ...missingReferences(componentReferences(text), known, nonCatalogNames),
      ]);
      for (const name of missing)
        problems.push(`${file}: unknown json-render component ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});

const nonSourceApis = {
  addEventListener:
    "Standard DOM EventTarget method, also used by EventSource.",
  getCanonicalLocales: "Standard ECMAScript Intl locale canonicalization API.",
  makeMyTool:
    "Placeholder tool factory defined by the plugin author in the example.",
};

test("backticked camelCase APIs in both reference editions exist in source", () => {
  const declared = new Set();
  for (const group of ["apps", "packages", "plugins", "scripts"]) {
    for (const file of sourceFiles(path.join(root, group))) {
      if (/[/\\](?:tests|__tests__|fixtures)[/\\]|\.(?:test|spec)\./.test(file))
        continue;
      for (const name of sourceNames(file, readFileSync(file, "utf8")))
        declared.add(name);
    }
  }
  const problems = [];
  for (const edition of ["docs/reference", "docs/en/reference"]) {
    for (const file of filesUnder(path.join(root, edition), ".md")) {
      for (const name of missingReferences(
        apiReferences(readFileSync(file, "utf8")),
        declared,
        nonSourceApis,
      ))
        problems.push(`${path.relative(root, file)}: unknown API ${name}()`);
    }
  }
  assert.deepEqual(problems, []);
});

test("reference gates reject seeded names in prose, tables and examples", () => {
  const components = componentReferences(
    'Use `RemovedWidget`.\n| `RetiredPanel` | text |\n```json\n{"component":"MissingCard"}\n```',
  );
  assert.deepEqual(missingReferences(components, new Set(["Card"])).sort(), [
    "MissingCard",
    "RemovedWidget",
    "RetiredPanel",
  ]);
  assert.deepEqual(
    missingReferences(
      specComponentReferences('{ "component": "Dialog" }'),
      new Set(["Card"]),
    ),
    ["Dialog"],
  );
  const apis = apiReferences("Call `ctx.removedApi()` or `oldHelper(value)`.");
  assert.deepEqual(
    missingReferences(
      apis,
      sourceNames("fixture.ts", "export function currentApi() {}"),
    ),
    ["removedApi", "oldHelper"],
  );
  assert.deepEqual(
    missingReferences(apis, new Set(), {
      removedApi: "Example API",
      oldHelper: "",
    }),
    ["oldHelper"],
  );
});
