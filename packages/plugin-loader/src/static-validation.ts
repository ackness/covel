import { planPluginAssetRoot } from "./ui-assets.js";
import {
  FRAMEWORK_TOOL_NAMES,
  isKernelExtensionContract,
  MAX_UI_WEBVIEW_BYTES,
  pluginUiSpecIssues,
} from "@covel/shared";
import path from "node:path";
import { datasetKeyIssue, datasetSchemaIssues } from "./dataset-rules.js";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";

/** Every declared server module, relative to the manifest that owns it. */
export function pluginImportReferences(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
): { source: string | undefined; field: string; reference: string }[] {
  const references: ReturnType<typeof pluginImportReferences> = [];
  const add = (
    source: string | undefined,
    field: string,
    reference?: string,
  ) => {
    if (reference) references.push({ source, field, reference });
  };
  add(packageManifest.sourcePath, "entry", packageManifest.plugin.entry);
  for (const [id, projection] of Object.entries(
    packageManifest.plugin.contributes?.worldProjections ?? {},
  ))
    add(
      packageManifest.sourcePath,
      `contributes.worldProjections.${id}.handler`,
      projection.handler,
    );
  for (const parsed of manifests) {
    add(parsed.sourcePath, "function.handler", parsed.manifest.handler);
    add(parsed.sourcePath, "guard", parsed.manifest.guard);
  }
  return references;
}

/**
 * Shared by discovery, author validation and installation; no code is
 * imported. A contract a runtime reads needs no declaration: listed in
 * `requires` it activates a provider, otherwise the runtime uses it when one
 * is active.
 */
export function validateRuntimeDeclarations(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
): void {
  const plugin = packageManifest.plugin;
  // The package provides each output contract; a consumer that binds the
  // contract gets one runtime's output, so two runtimes cannot share one.
  const outputs = new Set<string>();
  for (const parsed of manifests) {
    const contract = parsed.runtime?.io?.output?.contract;
    if (!contract) continue;
    if (outputs.has(contract))
      throw new Error(
        `${parsed.sourcePath}: ambiguous output contract ${contract}; only one runtime may provide it`,
      );
    outputs.add(contract);
  }
  // A story package must keep playing without any other package. `requires`
  // turns the whole package off when a provider is missing, so it cannot name
  // a plugin contract. The same rule on a runtime's inputs and `needs` is a
  // manifest rule (@covel/shared).
  const story = manifests.find(
    ({ runtime }) => runtime?.io?.visibility === "story",
  );
  if (story)
    for (const contract of plugin.requires ?? [])
      if (!isKernelExtensionContract(contract))
        throw new Error(
          `${packageManifest.sourcePath}: requires: a package with a story runtime (${story.sourcePath}) cannot require contract ${contract}: remove it from requires and bind it as an optional input (required: false), so the story still runs when no provider is active`,
        );
  for (const parsed of manifests) {
    const runtimeReferences = [
      ...(["needs", "after"] as const).flatMap((field) =>
        (parsed.runtime?.schedule?.[field] ?? []).flatMap((reference, index) =>
          typeof reference === "string"
            ? [{ runtimeId: reference, field: `schedule.${field}[${index}]` }]
            : "runtime" in reference
              ? [
                  {
                    runtimeId: reference.runtime,
                    field: `schedule.${field}[${index}].runtime`,
                  },
                ]
              : [],
        ),
      ),
      ...Object.entries(parsed.runtime?.io?.inputs ?? {}).flatMap(
        ([name, input]) =>
          "runtime" in input.from
            ? [
                {
                  runtimeId: input.from.runtime,
                  field: `io.inputs.${name}.from.runtime`,
                },
              ]
            : [],
      ),
    ];
    // Cross-package named runtime references are rejected by design (see docs/reference/plugins.md).
    // Within-package references (pluginId/runtimeName) are permitted for internal coordination.
    // Cross-package dependencies must use the contract system for stable, versioned coupling.
    for (const { runtimeId, field } of runtimeReferences) {
      if (runtimeId !== plugin.id && !runtimeId.startsWith(`${plugin.id}/`)) {
        if (!runtimeId.includes("/"))
          throw new Error(
            `${parsed.sourcePath}: ${field} references unprefixed runtime ${runtimeId}; use the complete runtime ID ${plugin.id}/${runtimeId} for a runtime in this package`,
          );
        throw new Error(
          `${parsed.sourcePath}: ${field} references runtime ${runtimeId} outside package ${plugin.id}; use a contract for cross-package dependencies`,
        );
      }
    }
  }
}

/**
 * Validate referenced files and runtime scheduling without executing modules.
 * Authoring validation and installation call it; `readFile` throws for a
 * missing file.
 */
export function validatePluginFiles(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
  readFile: (absolutePath: string) => string,
  listFiles?: (
    absoluteDir: string,
  ) => readonly { path: string; size: number }[],
): void {
  if (packageManifest.disabledRuntime)
    throw new Error(packageManifest.disabledRuntime.message);
  validateRuntimeDeclarations(packageManifest, manifests);
  if (!packageManifest.sourcePath)
    throw new Error("Static validation requires the PLUGIN.md source path");
  const root = path.resolve(path.dirname(packageManifest.sourcePath));
  const read = (
    source: string | undefined,
    field: string,
    reference: string,
  ): { resolved: string; content: string } => {
    if (!source)
      throw new Error(
        `Static validation requires the source path for ${field}`,
      );
    const resolved = path.resolve(path.dirname(source), reference);
    const relative = path.relative(root, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        `${source}: ${field}: ${reference} leaves the plugin root; use a package-local path`,
      );
    try {
      return { resolved, content: readFile(resolved) };
    } catch (error) {
      throw new Error(
        `${source}: ${field}: cannot read ${reference}: ${error instanceof Error ? error.message : String(error)}; include a valid file at this path`,
      );
    }
  };
  const file = (
    source: string | undefined,
    field: string,
    reference: string | undefined,
    json = false,
  ): unknown => {
    if (!reference || reference.startsWith("contract:")) return undefined;
    const { content } = read(source, field, reference);
    if (!json) return undefined;
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(
        `${source}: ${field}: cannot read ${reference}: ${error instanceof Error ? error.message : String(error)}; include a valid file at this path`,
      );
    }
  };
  const plugin = packageManifest.plugin;
  for (const { source, field, reference } of pluginImportReferences(
    packageManifest,
    manifests,
  ))
    file(source, field, reference);
  for (const [contract, declaration] of Object.entries(plugin.contracts ?? {}))
    file(
      packageManifest.sourcePath,
      `contracts.${contract}.schema`,
      declaration.schema,
      true,
    );
  for (const [namespace, declaration] of Object.entries(
    plugin.contributes?.data ?? {},
  ))
    file(
      packageManifest.sourcePath,
      `contributes.data.${namespace}.schema`,
      declaration.schema,
      true,
    );
  for (const [name, declaration] of Object.entries(
    plugin.contributes?.datasets ?? {},
  )) {
    const document = file(
      packageManifest.sourcePath,
      `contributes.datasets.${name}.schema`,
      declaration.schema,
      true,
    );
    const keyIssue = datasetKeyIssue(
      packageManifest.sourcePath,
      name,
      declaration,
      document,
    );
    if (keyIssue) throw new Error(keyIssue);
  }
  const [schemaIssue] = datasetSchemaIssues(
    packageManifest.sourcePath,
    root,
    plugin.contributes,
  );
  if (schemaIssue) throw new Error(schemaIssue);
  // The same rules decide whether the game shows the panel (`loadPluginUiSpecs`).
  const viewIds = new Set<string>();
  for (const slot of ["right", "message", "view"] as const)
    for (const reference of plugin.contributes?.ui?.[slot] ?? []) {
      const source = packageManifest.sourcePath;
      const field = `contributes.ui.${slot}`;
      if (!reference.endsWith(".json"))
        throw new Error(
          `${source}: ${field}: ${reference}: a UI spec is a JSON file; custom component files are not supported`,
        );
      const spec = file(source, field, reference, true);
      const problems = pluginUiSpecIssues(spec, plugin.id, slot);
      const id = (spec as { id?: unknown } | null)?.id;
      if (slot === "view" && typeof id === "string") {
        if (viewIds.has(id))
          problems.push({ path: "id", message: `duplicate view id "${id}"` });
        viewIds.add(id);
      }
      if (problems.length)
        throw new Error(
          problems
            .map(
              (problem) =>
                `${source}: ${field}: ${reference}: ${problem.path}: ${problem.message}`,
            )
            .join("\n"),
        );
      const webview = (spec as { webview?: { root?: string; entry?: string } })
        .webview;
      const entry = webview?.entry;
      if (!entry) continue;
      const specFile = path.resolve(path.dirname(source!), reference);
      if (webview?.root !== undefined) {
        if (!listFiles)
          throw new Error(
            `${specFile}: webview.root: cannot list webview.root`,
          );
        const assetRoot = path.resolve(root, webview.root);
        let files: readonly { path: string; size: number }[];
        try {
          files = listFiles(assetRoot);
        } catch (error) {
          throw new Error(
            `${specFile}: webview.root: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const plan = planPluginAssetRoot(
          files.map((file) => ({
            relativePath: path
              .relative(assetRoot, file.path)
              .split(path.sep)
              .join("/"),
            size: file.size,
          })),
          path.posix.normalize(entry),
        );
        if (plan.issues.length)
          throw new Error(
            plan.issues
              .map((issue) => `${specFile}: ${issue.path}: ${issue.message}`)
              .join("\n"),
          );
        continue;
      }
      const { content } = read(specFile, "webview.entry", entry);
      if (Buffer.byteLength(content) > MAX_UI_WEBVIEW_BYTES)
        throw new Error(
          `${specFile}: webview.entry: ${entry} exceeds ${MAX_UI_WEBVIEW_BYTES / 1024} KiB`,
        );
    }
  for (const parsed of manifests) {
    const runtime = parsed.manifest;
    file(parsed.sourcePath, "io.output.schema", runtime.output?.schema, true);
    file(parsed.sourcePath, "io.payloadSchema", runtime.input?.schema, true);
    // Committed bindings compile into input.inject, not runtime.inputs.
    // Validate both scopes from the authored declarations to retain field paths.
    const inputs = parsed.runtime?.io?.inputs ?? {};
    for (const [name, input] of Object.entries(inputs))
      file(parsed.sourcePath, `io.inputs.${name}.accepts`, input.accepts, true);
    for (const tool of runtime.tools?.builtin ?? []) {
      if (!(FRAMEWORK_TOOL_NAMES as readonly string[]).includes(tool))
        throw new Error(
          `${parsed.sourcePath}: tools.builtin: unknown tool ${tool}; use a documented framework tool name`,
        );
    }
    for (const [binding, input] of Object.entries(inputs)) {
      const runtimeId =
        "runtime" in input.from ? input.from.runtime : undefined;
      if (
        runtimeId &&
        !manifests.some((candidate) => candidate.manifest.name === runtimeId)
      )
        throw new Error(
          `${parsed.sourcePath}: io.inputs.${binding}: runtime ${runtimeId} does not exist in this package`,
        );
    }
    for (const tool of runtime.tools?.plugin ?? []) {
      if (!plugin.contributes?.tools?.includes(tool))
        throw new Error(
          `${parsed.sourcePath}: tools.plugin: ${tool} is not declared in contributes.tools`,
        );
    }
    for (const [field, refs] of [
      ["needs", runtime.needs],
      ["after", runtime.after],
    ] as const)
      for (const ref of refs ?? []) {
        const name =
          typeof ref === "string"
            ? ref
            : "runtime" in ref
              ? ref.runtime
              : undefined;
        if (
          name &&
          !manifests.some((candidate) => candidate.manifest.name === name)
        )
          throw new Error(
            `${parsed.sourcePath}: schedule.${field}: runtime ${name} does not exist in this package`,
          );
      }
  }
}

/**
 * A plugin package is ESM. A package without `package.json` needs nothing:
 * the host loads its `.js` files as ES modules (`provideHostModules`). One
 * with a `package.json` must say `"type": "module"`; otherwise Node reads the
 * package's `.js` files as CommonJS, which the host loads through another
 * path: an `import` in them fails, and the development reload never picks up
 * a change. Returns what is wrong, or undefined.
 */
export function packageModuleTypeProblem(packageJson: {
  type?: unknown;
}): string | undefined {
  if (packageJson.type === "module") return undefined;
  return `package.json must declare "type": "module" (found ${
    packageJson.type === undefined
      ? "no type"
      : JSON.stringify(packageJson.type)
  }); a plugin package is ESM`;
}
