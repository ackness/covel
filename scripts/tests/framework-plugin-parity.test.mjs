import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseSync } from "oxc-parser";

// Framework code treats every plugin alike: it never names a concrete plugin,
// and a package's source (`builtin` / `community`) decides only trust. These
// checks catch regressions that review used to be the only guard against.

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Files allowed to compare a `source` with "builtin" / "community", and why.
 * Each reason must be about trust, approval, uninstalling or labelling, or
 * about a source that is not a plugin's. A capability or presentation branch
 * on plugin source belongs in a declaration instead.
 */
const SOURCE_COMPARISON_ALLOWLIST = new Map([
  ["packages/plugin-loader/src/trust.ts", "derives trust from discovery"],
  [
    "packages/shared/src/plugin-selection.ts",
    "only authorized packages join a session automatically",
  ],
  ["apps/server/src/routes/api/plugin-rpc.ts", "community code approval"],
  [
    "apps/server/src/routes/api/plugin-rpc/event-dispatch.ts",
    "community code approval",
  ],
  [
    "apps/server/src/routes/api/session/plugin-routes.ts",
    "community code approval",
  ],
  ["apps/server/src/routes/api/session/plugins.ts", "community code approval"],
  [
    "apps/server/src/trust/trusted-source-service.ts",
    "trusted sources cover community packages",
  ],
  [
    "apps/server/src/lib/plugin-descriptor.ts",
    "community packages report their trust summary",
  ],
  [
    "apps/server/src/routes/api/plugins.ts",
    "bundled packages cannot be uninstalled",
  ],
  [
    "apps/server/src/routes/api/worlds/plugin-plan.ts",
    "authorization for world plugin plans",
  ],
  [
    "apps/web/src/components/session/session-prep/plugin-selection-helpers.ts",
    "authorization, mirroring the server resolver",
  ],
  [
    "apps/web/src/components/session/plugin-list-panel/plugin-item.tsx",
    "source badge",
  ],
  [
    "apps/web/src/settings/panes/PackagesPane.tsx",
    "bundled packages cannot be uninstalled",
  ],
  ["apps/web/src/theme-system/registry.ts", "theme source, not plugin"],
  ["apps/web/src/theme-system/builtins.ts", "theme source, not plugin"],
  [
    "apps/web/src/settings/panes/AppearancePane.tsx",
    "theme source, not plugin",
  ],
]);

/** Plugin IDs that are also framework words, with the framework meaning. */
const GENERIC_WORD_IDS = new Map([
  ["memory", "a storage backend name"],
  ["inventory", "a UI component type"],
]);

/** Single literals allowed in one file: `file\0literal` → reason. */
const LITERAL_ALLOWLIST = new Map([
  [
    "packages/shared/src/schemas/plugin-manifest.ts\0dice-check",
    "a JSON Schema documentation example",
  ],
]);

function isFrameworkFile(file) {
  const parts = file.split("/");
  const framework =
    (parts[0] === "packages" && parts[2] === "src") ||
    file.startsWith("apps/server/src/") ||
    file.startsWith("apps/web/src/");
  return (
    framework &&
    /\.(?:[cm]?[jt]sx?)$/.test(file) &&
    !file.endsWith(".d.ts") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    !parts.some((part) =>
      ["test", "tests", "__tests__", "__fixtures__", "fixtures"].includes(part),
    ) &&
    // Backend contract suites are shared tests that use plugin IDs as fixtures.
    !file.startsWith("packages/store/src/contract/")
  );
}

function nodes(program) {
  const all = [];
  const pending = [program];
  while (pending.length) {
    const node = pending.pop();
    all.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        pending.push(
          ...value.filter((entry) => entry && typeof entry.type === "string"),
        );
      else if (value && typeof value.type === "string") pending.push(value);
    }
  }
  return all;
}

function stringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  return undefined;
}

function isSourceExpression(node) {
  if (node?.type === "ChainExpression")
    return isSourceExpression(node.expression);
  if (node?.type === "Identifier") return node.name === "source";
  if (node?.type === "MemberExpression")
    return node.computed
      ? node.property?.value === "source"
      : node.property?.name === "source";
  return false;
}

export function parityProblems(files, pluginIds) {
  const problems = [];
  const comparedSource = new Set();
  for (const [file, text] of files) {
    if (!isFrameworkFile(file)) continue;
    const parsed = parseSync(file, text);
    if (parsed.errors.length)
      throw new Error(`${file}: ${parsed.errors[0].message}`);
    const line = (node) => text.slice(0, node.start).split("\n").length;
    for (const node of nodes(parsed.program)) {
      const literal = stringValue(node);
      if (
        literal !== undefined &&
        pluginIds.has(literal) &&
        !GENERIC_WORD_IDS.has(literal) &&
        !LITERAL_ALLOWLIST.has(`${file}\0${literal}`)
      )
        problems.push(
          `${file}:${line(node)}: names the bundled plugin "${literal}"; discover providers through contracts, extension points or services`,
        );
      if (
        node.type === "BinaryExpression" &&
        ["===", "!==", "==", "!="].includes(node.operator)
      ) {
        const sides = [node.left, node.right];
        const compared = sides.map(stringValue);
        if (
          compared.some(
            (value) => value === "builtin" || value === "community",
          ) &&
          sides.some(isSourceExpression)
        ) {
          comparedSource.add(file);
          if (!SOURCE_COMPARISON_ALLOWLIST.has(file))
            problems.push(
              `${file}:${line(node)}: branches on package source; source decides only trust (add the file to the allowlist only for trust, approval, uninstall or labels)`,
            );
        }
      }
    }
  }
  return { problems, comparedSource };
}

function bundledPluginIds() {
  const ids = new Set();
  const manifests = execFileSync(
    "git",
    ["ls-files", "-z", "--", "plugins/*/PLUGIN.md"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of manifests) {
    const frontmatter = readFileSync(path.join(root, file), "utf8").match(
      /^---\n([\s\S]*?)\n---/,
    )?.[1];
    const id = frontmatter?.match(/^id:\s*["']?([^"'\s#]+)/m)?.[1];
    ids.add(id ?? path.basename(path.dirname(file)));
  }
  return ids;
}

test("the parity gate rejects plugin IDs and source branches", () => {
  const ids = new Set(["narrator", "memory"]);
  const { problems } = parityProblems(
    [
      ["packages/runtime/src/x.ts", 'if (id === "narrator") run();'],
      ["apps/web/src/y.tsx", "const id = `narrator`;"],
      ["apps/server/src/z.ts", 'if (entry.source === "builtin") skip();'],
      [
        "apps/server/src/w.ts",
        'if (getTrust(id)?.source !== "community") a();',
      ],
    ],
    ids,
  );
  assert.equal(problems.length, 4, problems.join("\n"));
});

test("the parity gate ignores comments, tests, generic words and other sources", () => {
  const ids = new Set(["narrator", "memory"]);
  const { problems } = parityProblems(
    [
      [
        "packages/runtime/src/x.ts",
        '// "narrator" is an example\nconst b = "memory";',
      ],
      ["packages/runtime/src/x.test.ts", 'const id = "narrator";'],
      ["packages/runtime/tests/x.ts", 'const id = "narrator";'],
      ["apps/server/src/__tests__/x.ts", 'const id = "narrator";'],
      ["packages/store/src/contract/suite.ts", 'const id = "narrator";'],
      ["plugins/narrator/entry.ts", 'const id = "narrator";'],
      [
        "apps/server/src/z.ts",
        'if (kind === "builtin") a(); const narratorId = id;',
      ],
    ],
    ids,
  );
  assert.deepEqual(problems, []);
});

test("framework code never names a bundled plugin or branches on its source", () => {
  const ids = bundledPluginIds();
  assert.ok(ids.size > 0, "the scan must find bundled plugins");
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages",
      "apps/server/src",
      "apps/web/src",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) =>
        file && isFrameworkFile(file) && existsSync(path.join(root, file)),
    );
  assert.ok(files.length > 0, "the scan must find framework sources");
  const { problems, comparedSource } = parityProblems(
    files.map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
    ids,
  );
  assert.deepEqual(problems, []);
  const stale = [...SOURCE_COMPARISON_ALLOWLIST.keys()].filter(
    (file) => !comparedSource.has(file),
  );
  assert.deepEqual(
    stale,
    [],
    "remove allowlist entries that no longer compare source",
  );
});
