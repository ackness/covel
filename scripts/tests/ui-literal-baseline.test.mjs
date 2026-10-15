/**
 * UI text ratchet: one hit per JSX text node or string/template literal rendered
 * as a child or a named text prop below. Count Han/Kana/Hangul or ASCII words
 * (two letters, or A/I); ignore whitespace, punctuation, numbers and URL-only
 * text. Decode numeric JSX entities; ignore named entities (symbols/spaces).
 * Parse syntax, never comments or arbitrary source strings.
 *
 * In expressions, inspect direct literals, template text, conditional result
 * arms, logical fallbacks and concatenations. Do not follow variables, calls
 * (including t() keys/defaults), object fields, conditions or template values.
 * Props are an explicit allowlist: classes, ids, URLs, keys and test ids are
 * never text props. This is a conservative count, not a full i18n linter.
 * Skip /debug, tests, stories and locale catalogs. Existing literals stay until
 * translated in another change; counts may only decrease, including --update.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baselinePath = new URL("./ui-literal-baseline.json", import.meta.url);
const updateCommand =
  "node scripts/tests/ui-literal-baseline.test.mjs --update";
const textProps = new Set([
  "title",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "label",
  "description",
  "tooltip",
  "helperText",
  "errorMessage",
  "emptyMessage",
  "loadingText",
  "buttonText",
  "confirmText",
  "cancelText",
  "children",
]);

function isUiFile(file) {
  const parts = file.split("/");
  return (
    /\.[jt]sx$/.test(file) &&
    !parts.some((part) =>
      ["__tests__", "tests", "__stories__", "stories", "locales"].includes(
        part,
      ),
    ) &&
    !/\.(test|spec|stories|story)\.[jt]sx$/.test(file) &&
    file !== "apps/web/src/routes/debug.tsx" &&
    !file.startsWith("apps/web/src/routes/debug/")
  );
}

function literals(file, source) {
  const parsed = parseSync(file, source);
  assert.equal(
    parsed.errors.length,
    0,
    `${file}: ${parsed.errors[0]?.message}`,
  );
  const hits = new Map();
  function record(node, value, jsxEntities = false) {
    const text = (
      jsxEntities
        ? value
            .replaceAll(
              /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
              (_match, hex, decimal) => {
                const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
                return code <= 0x10ffff ? String.fromCodePoint(code) : " ";
              },
            )
            .replaceAll(/&[a-z][a-z0-9]*;/gi, " ")
        : value
    ).trim();
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|www\.)\S+$/i.test(text)) return;
    if (
      !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[a-z]{2}|\b[AI]\b/iu.test(
        text,
      )
    )
      return;
    const offset = node.start + source.slice(node.start, node.end).search(/\S/);
    hits.set(node.start, {
      line: source.slice(0, offset).split("\n").length,
      text,
    });
  }
  function rendered(node, jsxEntities = false) {
    if (!node) return;
    if (node.type === "Literal" && typeof node.value === "string")
      record(node, node.value, jsxEntities);
    else if (node.type === "TemplateLiteral") {
      // One template is one literal, regardless of its number of interpolations.
      record(
        node,
        node.quasis
          .map((part) => part.value.cooked ?? part.value.raw)
          .join(" "),
      );
    } else if (node.type === "JSXExpressionContainer")
      rendered(node.expression);
    else if (node.type === "ConditionalExpression") {
      rendered(node.consequent);
      rendered(node.alternate);
    } else if (node.type === "LogicalExpression") {
      if (node.operator !== "&&") rendered(node.left);
      rendered(node.right);
    } else if (node.type === "BinaryExpression" && node.operator === "+") {
      rendered(node.left);
      rendered(node.right);
    }
  }
  function visit(node) {
    if (node.type === "JSXText") record(node, node.value, true);
    if (node.type === "JSXAttribute" && textProps.has(node.name.name))
      rendered(node.value, true);
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      for (const child of node.children) rendered(child);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === "string") visit(child);
      } else if (value && typeof value.type === "string") visit(value);
    }
  }
  visit(parsed.program);
  return [...hits.entries()].sort(([a], [b]) => a - b).map(([, hit]) => hit);
}

function scan() {
  return Object.fromEntries(
    readdirSync(path.join(root, "apps/web/src"), { recursive: true })
      .map((file) => `apps/web/src/${file.split(path.sep).join("/")}`)
      .filter(isUiFile)
      .sort()
      .map((file) => [
        file,
        literals(file, readFileSync(path.join(root, file), "utf8")),
      ])
      .filter(([, hits]) => hits.length),
  );
}

function problems(actual, baseline, allowDecrease = false) {
  const errors = [];
  for (const file of new Set([
    ...Object.keys(actual),
    ...Object.keys(baseline),
  ])) {
    const hits = actual[file] ?? [];
    const limit = baseline[file] ?? 0;
    if (hits.length > limit) {
      errors.push(
        `${file}: ${hits.length} UI literals, baseline ${limit}. Use i18n; the baseline cannot increase.\n` +
          hits
            .map(
              ({ line, text }) => `  ${file}:${line}: ${JSON.stringify(text)}`,
            )
            .join("\n"),
      );
    } else if (hits.length < limit && !allowDecrease) {
      errors.push(
        `${file}: ${hits.length} UI literals, baseline ${limit}. Lower the baseline with: ${updateCommand}`,
      );
    }
  }
  return errors;
}

if (process.argv.includes("--update")) {
  const actual = scan();
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.deepEqual(problems(actual, baseline, true), []);
  writeFileSync(
    baselinePath,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(actual).map(([file, hits]) => [file, hits.length]),
      ),
      null,
      2,
    ) + "\n",
  );
  console.log("Updated UI literal baseline (counts can only decrease).");
} else {
  test("UI literal counts match the decreasing per-file baseline", () => {
    assert.deepEqual(
      problems(scan(), JSON.parse(readFileSync(baselinePath, "utf8"))),
      [],
    );
  });

  test("finds rendered text and text props without counting implementation strings", () => {
    const source = `const view = <section className="flex gap-2" id="panel-id" data-testid="panel" key="key">
      Hello player
      <input title="Save game" placeholder={'Type here'} aria-label="玩家名字" />
      <img src="https://example.com/art.png" alt="A portrait" />
      {ready === "yes" ? "Ready" : t("status.waiting", "Waiting")}
      {ready && 'Continue'}
      <span title={t("title.key")} data-state="open">{t("child.key")}</span>
      <a href="https://example.com">https://example.com</a>
      <a href="mailto:help@example.com">mailto:help@example.com</a>
      <span>&nbsp;&hellip;&#x2026;</span><span>&#x4E2D;</span>
      {/* Comment text */}{'…'}{42}
    </section>;`;
    assert.deepEqual(
      literals("fixture.tsx", source).map((hit) => hit.text),
      [
        "Hello player",
        "Save game",
        "Type here",
        "玩家名字",
        "A portrait",
        "Ready",
        "Continue",
        "中",
      ],
    );
  });

  test("counts template text, fallbacks and string children once each", () => {
    assert.deepEqual(
      literals(
        "fixture.tsx",
        "const view = <><p title={`Hello ${name}`}>{'Save'}</p>{label ?? 'Unnamed'}{name + ' joined'}</>;",
      ).map((hit) => hit.text),
      ["Hello", "Save", "Unnamed", "joined"],
    );
  });

  test("excludes debug pages, tests, stories and locale catalogs", () => {
    for (const file of [
      "routes/debug.tsx",
      "routes/debug/-panel.tsx",
      "a.test.tsx",
      "a.spec.jsx",
      "a.stories.tsx",
      "__tests__/a.tsx",
      "i18n/locales/catalog.tsx",
    ]) {
      assert.equal(isUiFile(`apps/web/src/${file}`), false, file);
    }
    assert.equal(isUiFile("apps/web/src/components/debug-button.tsx"), true);
  });

  test("rejects seeded text in new/existing files and requires lowered or removed entries", () => {
    const actual = {
      "new.tsx": literals(
        "new.tsx",
        "const view = <p>Seeded untranslated text</p>;",
      ),
    };
    assert.match(
      problems(actual, {}).join("\n"),
      /new\.tsx:1: "Seeded untranslated text"/,
    );
    assert.equal(
      problems(actual, {}, true).length,
      1,
      "--update must not absorb new literals",
    );
    assert.equal(problems(actual, { "new.tsx": 1 }).length, 0);
    assert.match(
      problems(actual, { "new.tsx": 2 }).join("\n"),
      /Lower the baseline with: node/,
    );
    assert.equal(problems(actual, { "new.tsx": 2 }, true).length, 0);
    assert.match(
      problems({}, { "removed.tsx": 1 }).join("\n"),
      /removed\.tsx: 0 UI literals/,
    );
  });
}
