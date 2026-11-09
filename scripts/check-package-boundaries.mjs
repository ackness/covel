#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageImports } from "./lib/package-imports.mjs";
import { unusedPackageExports } from "./lib/package-exports.mjs";
import { testSourceImportErrors } from "./lib/test-source-imports.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const layers = {
  shared: ["plugin-handlers-utils"],
  "ai-provider": ["shared"],
  approval: ["shared"],
  context: ["shared", "plugin-handlers-utils"],
  create: ["context", "shared"],
  events: ["shared"],
  memory: ["shared", "store", "plugin-handlers-utils"],
  "plugin-handlers-utils": [],
  "plugin-loader": ["events", "shared"],
  // Tool fixtures use runtime's scoped-read implementation and store/tool types.
  // sdk-alignment asserts the public SDK stays structurally equal to shared.
  "plugin-test-utils": [
    "plugin-handlers-utils",
    "plugin-loader",
    "runtime",
    "shared",
    "store",
    "tools",
  ],
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
    "approval",
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
  tools: ["shared", "plugin-handlers-utils"],
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
        // Plugin modules execute as written; no compiler maps `.js` to `.ts`.
        if (
          workspace.group === "plugins" &&
          !typeOnly &&
          !statSync(target, { throwIfNoEntry: false })?.isFile()
        )
          fail("relative import must name an existing file");
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
        ) &&
        // Desktop main/preload bundle shared's public entries. Its build rejects
        // emitted package imports, so no desktop node_modules is shipped.
        !(
          workspace.group === "apps" &&
          workspace.name === "desktop" &&
          name === "@covel/shared" &&
          workspace.manifest.devDependencies?.[name]
        ) &&
        // The host provides the SDK to every plugin at run time
        // (`HOST_MODULES` in plugin-loader); an installable plugin declares
        // no runtime dependency, so a development one is enough.
        !(
          workspace.group === "plugins" &&
          name === "@covel/plugin-handlers-utils" &&
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
      if (entry === "./testing" && name !== workspace.manifest.name)
        fail(
          "the ./testing entry is for tests; production source must not import it",
        );
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
errors.push(
  ...unusedPackageExports(root, workspaces, {
    "@covel/plugin-handlers-utils/image-generation":
      "Public plugin SDK entry for community image providers.",
    "@covel/plugin-handlers-utils/extension-points":
      "Public plugin SDK entry for community extension providers.",
    "@covel/plugin-handlers-utils/plugin-api":
      "Public plugin SDK entry for community entry modules.",
  }),
);

// Tests that still reach into another workspace by relative path. Each target
// has no public or `./testing` entry on purpose; moving it behind one would
// expose an internal or invert a dependency. Add an entry only with the same
// kind of reason, and remove it once the test uses a package entry.
const mockedTransport =
  "vi.mock must name the module the package's own files import; the outbound transport has no entry of its own, and the tests stub it below the gateway.";
const testImportAllowlist = [
  {
    from: "apps/server/tests/api/memory-llm-policy.test.ts",
    imports: ["packages/ai-provider/src/outbound-network.js"],
    reason: mockedTransport,
  },
  {
    from: "apps/server/tests/api/reasoning-overrides.test.ts",
    imports: ["packages/ai-provider/src/outbound-network.js"],
    reason: mockedTransport,
  },
  {
    from: "apps/server/tests/bootstrap/llm-request-observation.test.ts",
    imports: [
      "packages/ai-provider/src/outbound-network.js",
      "packages/runtime/src/retry/llm-retry.js",
      "packages/runtime/src/retry/retry-common.js",
    ],
    reason: `${mockedTransport} The retry loop is runtime-internal; the test drives it against a real gateway to observe request traces.`,
  },
  {
    from: "apps/server/tests/integration/pg-runtime-export-failure.test.ts",
    imports: ["packages/runtime/src/commit/runtime-export-publish.js"],
    reason:
      "Runtime-internal export publisher, driven directly to inject one failing PostgreSQL INSERT after finalization.",
  },
  {
    from: "apps/server/tests/api/delegation-privacy.test.ts",
    imports: ["packages/runtime/tests/_helpers/actor-agent-composition.js"],
    reason:
      "Runtime test scenario shared with runtime's own suite; it depends on runtime-internal modules and test fixtures that have no entry.",
  },
  {
    from: "apps/server/tests/integration/read-baseline-commit-pg.test.ts",
    imports: ["packages/runtime/tests/helpers/selfdata-baseline-suite.js"],
    reason:
      "Runtime suite rerun against PostgreSQL; it depends on runtime-internal modules and test fixtures that have no entry.",
  },
  {
    from: "apps/server/tests/api/config-api.test.ts",
    imports: ["apps/desktop/src/env-files.js"],
    reason:
      "Checks the server reads key files like the desktop shell; apps publish no entries and the server must not depend on desktop.",
  },
  {
    from: "packages/memory/tests/vector-memory.test.ts",
    imports: [
      "packages/ai-provider/src/adapters/http/response.js",
      "packages/ai-provider/src/gateway-lifecycle.js",
    ],
    reason:
      "Reproduces the exact error an embedding adapter throws; these adapter internals are not part of ai-provider's surface.",
  },
  {
    from: "packages/runtime/tests/bundled-orchestration.test.ts",
    imports: ["packages/test-runtime/src/runtime-loading.js"],
    reason:
      "test-runtime is a CLI without import entries and already depends on runtime; an entry would create a dependency cycle.",
  },
  {
    from: "packages/runtime/tests/helpers/narrative-attribution.ts",
    imports: ["packages/test-runtime/src/runtime-loading.js"],
    reason:
      "test-runtime is a CLI without import entries and already depends on runtime; an entry would create a dependency cycle.",
  },
  {
    from: "plugins/char-creator/tests/character-tracker-runtime.test.js",
    imports: ["packages/test-runtime/src/runtime-loading.ts"],
    reason:
      "test-runtime is a CLI without import entries; the test loads the plugin the way the CLI does.",
  },
  {
    from: "plugins/affinity/tests/haruka-relationship-authority.test.js",
    imports: [
      "apps/server/src/config/plugin-packs.ts",
      "apps/server/src/routes/api/session/plugins.ts",
      "apps/server/src/world-data/requirements.ts",
      "apps/server/src/world-seed-loader.ts",
      "apps/server/tests/helpers/world-data-import.ts",
    ],
    reason:
      "End-to-end world check through the server's own session planning and world-data import; apps publish no entries.",
  },
];
errors.push(...testSourceImportErrors(root, workspaces, testImportAllowlist));

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Package boundaries verified across ${workspaces.length} workspaces.`,
  );
