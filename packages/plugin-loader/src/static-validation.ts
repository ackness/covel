import {
  FRAMEWORK_TOOL_NAMES,
  MAX_UI_WEBVIEW_BYTES,
  pluginUiSpecIssues,
} from "@covel/shared";
import path from "node:path";
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

/** Shared by discovery, author validation and installation; no code is imported. */
export function validateRuntimeDeclarations(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
): void {
  const plugin = packageManifest.plugin;
  const provided = new Set(
    (plugin.provides ?? []).map((p) =>
      typeof p === "string" ? p : p.contract,
    ),
  );
  const outputs = new Set<string>();
  for (const parsed of manifests) {
    const contract = parsed.runtime?.io?.output?.contract;
    if (!contract) continue;
    if (!provided.has(contract))
      throw new Error(
        `${parsed.sourcePath}: output contract ${contract} is not declared in root provides`,
      );
    if (outputs.has(contract))
      throw new Error(
        `${parsed.sourcePath}: ambiguous output contract ${contract}; only one runtime may provide it`,
      );
    outputs.add(contract);
  }
  const dependencies = new Set([
    ...(plugin.requires ?? []),
    ...(plugin.optional ?? []),
  ]);
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
    const references = [
      ...(parsed.runtime?.schedule?.needs ?? []).flatMap((need) =>
        typeof need === "object" && "contract" in need
          ? [{ contract: need.contract, field: "schedule.needs" }]
          : [],
      ),
      ...Object.entries(parsed.runtime?.io?.inputs ?? {}).flatMap(
        ([name, input]) =>
          "contract" in input.from
            ? [
                {
                  contract: input.from.contract,
                  field: `io.inputs.${name}.from.contract`,
                },
              ]
            : [],
      ),
    ];
    for (const { contract, field } of references) {
      if (!dependencies.has(contract))
        throw new Error(
          `${parsed.sourcePath}: ${field} contract ${contract} must be declared in root requires or optional`,
        );
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
  // The same rules decide whether the game shows the panel (`loadPluginUiSpecs`).
  for (const [slot, paths] of Object.entries(plugin.contributes?.ui ?? {}))
    for (const reference of paths ?? []) {
      const source = packageManifest.sourcePath;
      const field = `contributes.ui.${slot}`;
      if (!reference.endsWith(".json"))
        throw new Error(
          `${source}: ${field}: ${reference}: a UI spec is a JSON file; custom component files are not supported`,
        );
      const spec = file(source, field, reference, true);
      const problems = pluginUiSpecIssues(spec, plugin.id);
      if (problems.length)
        throw new Error(
          problems
            .map(
              (problem) =>
                `${source}: ${field}: ${reference}: ${problem.path}: ${problem.message}`,
            )
            .join("\n"),
        );
      const entry = (spec as { webview?: { entry?: string } }).webview?.entry;
      if (!entry) continue;
      const specFile = path.resolve(path.dirname(source!), reference);
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
 * A plugin package is ESM: its `package.json` says `"type": "module"`. Without
 * it Node reads the package's `.js` files as CommonJS, which the host loads
 * through another path: an `import` in them fails, and the development reload
 * never picks up a change. Returns what is wrong, or undefined.
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
