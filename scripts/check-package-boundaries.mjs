#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageImports } from "./lib/package-imports.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const layers = {
  shared: [],
  "ai-provider": ["shared"],
  approval: ["shared"],
  context: ["shared"],
  create: ["context", "shared"],
  events: ["shared"],
  memory: ["shared", "store"],
  "plugin-handlers-utils": ["shared"],
  "plugin-loader": ["events", "shared"],
  // Tool fixtures use runtime's scoped-read implementation and store/tool types.
  "plugin-test-utils": ["plugin-loader", "runtime", "shared", "store", "tools"],
  runtime: [
    "ai-provider",
    "approval",
    "context",
    "events",
    "shared",
    "store",
    "tools",
  ],
  settings: ["shared"],
  store: ["shared"],
  "test-runtime": [
    "ai-provider",
    "context",
    "events",
    "plugin-loader",
    "plugin-test-utils",
    "runtime",
    "shared",
    "store",
    "tools",
  ],
  tools: ["shared"],
};
const workspaces = ["apps", "packages", "plugins"].flatMap((group) =>
  readdirSync(path.join(root, group)).flatMap((name) => {
    const directory = path.join(root, group, name);
    const manifest = path.join(directory, "package.json");
    return existsSync(manifest)
      ? [
          {
            group,
            name,
            directory,
            manifest: JSON.parse(readFileSync(manifest, "utf8")),
          },
        ]
      : [];
  }),
);
const byName = new Map(
  workspaces.map((workspace) => [workspace.manifest.name, workspace]),
);
const errors = [];
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ["node_modules", "dist", "tests", "__tests__", "fixtures"].includes(
        entry.name,
      )
    )
      return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(file)
      : /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !/\.(?:test|spec)\./.test(file)
        ? [file]
        : [];
  });
}
for (const workspace of workspaces) {
  const production =
    workspace.group === "plugins"
      ? workspace.directory
      : path.join(workspace.directory, "src");
  if (!existsSync(production)) continue;
  for (const file of walk(production)) {
    const source = readFileSync(file, "utf8");
    const imports = packageImports(file, source);
    for (const { specifier, typeOnly } of imports) {
      const fail = (reason) =>
        errors.push(`${path.relative(root, file)}: ${specifier}: ${reason}`);
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const owner = workspaces.find((item) =>
          target.startsWith(`${item.directory}${path.sep}`),
        );
        if (owner && owner !== workspace)
          fail("cross-workspace source import; use the package's public entry");
        continue;
      }
      if (!specifier.startsWith("@covel/")) continue;
      const parts = specifier.split("/");
      const name = parts.slice(0, 2).join("/");
      const target = byName.get(name);
      if (!target) {
        fail("unknown workspace package");
        continue;
      }
      if (
        name !== workspace.manifest.name &&
        !workspace.manifest.dependencies?.[name] &&
        !(
          workspace.name === "test-runtime" &&
          workspace.manifest.devDependencies?.[name]
        )
      )
        fail("production source requires a declared production dependency");
      const entry = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`;
      if (
        target.manifest.exports &&
        !Object.hasOwn(target.manifest.exports, entry)
      )
        fail("entry is not exported by the package");
      if (
        workspace.group === "packages" &&
        name !== workspace.manifest.name &&
        !(layers[workspace.name] ?? []).includes(target.name)
      )
        fail("dependency crosses the documented package direction");
      if (
        !typeOnly &&
        specifier === "@covel/store" &&
        workspace.name !== "store"
      )
        fail("value import loads every backend; select a store subpath");
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Package boundaries verified across ${workspaces.length} workspaces.`,
  );
