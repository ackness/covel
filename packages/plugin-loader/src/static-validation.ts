import { FRAMEWORK_TOOL_NAMES } from "@covel/shared";
import path from "node:path";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";

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
      if (runtimeId !== plugin.id && !runtimeId.startsWith(`${plugin.id}/`))
        throw new Error(
          `${parsed.sourcePath}: ${field} references runtime ${runtimeId} outside package ${plugin.id}; use a contract for cross-package dependencies`,
        );
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

/** Validate referenced files and runtime scheduling without executing modules. */
export function validatePluginFiles(
  packageManifest: ParsedPluginMd,
  manifests: readonly ParsedRuntimeMd[],
  readFile: (absolutePath: string) => string,
): void {
  validateRuntimeDeclarations(packageManifest, manifests);
  if (!packageManifest.sourcePath)
    throw new Error("Static validation requires the PLUGIN.md source path");
  const root = path.resolve(path.dirname(packageManifest.sourcePath));
  const file = (
    source: string | undefined,
    field: string,
    reference: string | undefined,
    json = false,
  ): void => {
    if (!reference || reference.startsWith("contract:")) return;
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
      const content = readFile(resolved);
      if (json) JSON.parse(content);
    } catch (error) {
      throw new Error(
        `${source}: ${field}: cannot read ${reference}: ${error instanceof Error ? error.message : String(error)}; include a valid file at this path`,
      );
    }
  };
  const plugin = packageManifest.plugin;
  file(packageManifest.sourcePath, "entry", plugin.entry);
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
  for (const [slot, paths] of Object.entries(plugin.contributes?.ui ?? {}))
    for (const reference of paths ?? [])
      file(
        packageManifest.sourcePath,
        `contributes.ui.${slot}`,
        reference,
        reference.endsWith(".json"),
      );
  for (const parsed of manifests) {
    const runtime = parsed.manifest;
    const type = runtime.trigger?.type ?? "auto";
    if ((type === "auto" || type === "scheduled") && !runtime.stage)
      throw new Error(
        `${parsed.sourcePath}: schedule.stage is required for ${type}; choose setup, pre-turn, narrative, post-turn or audit`,
      );
    file(parsed.sourcePath, "function.handler", runtime.handler);
    file(parsed.sourcePath, "guard", runtime.guard);
    file(parsed.sourcePath, "io.output.schema", runtime.output?.schema, true);
    file(parsed.sourcePath, "io.payloadSchema", runtime.input?.schema, true);
    for (const [name, input] of Object.entries(runtime.inputs ?? {}))
      file(parsed.sourcePath, `io.inputs.${name}.accepts`, input.accepts, true);
    for (const tool of runtime.tools?.builtin ?? []) {
      if (!(FRAMEWORK_TOOL_NAMES as readonly string[]).includes(tool))
        throw new Error(
          `${parsed.sourcePath}: tools.builtin: unknown tool ${tool}; use a documented framework tool name`,
        );
    }
    for (const [binding, input] of Object.entries(runtime.inputs ?? {})) {
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
