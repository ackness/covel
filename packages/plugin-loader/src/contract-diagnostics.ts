import { isKernelExtensionContract } from "@covel/shared";
import { pluginRuntimeManifests } from "./declarations.js";
import type { PluginRegistryEntry } from "./types.js";

/**
 * Cross-package contract checks that no single manifest can decide: consumed
 * data contracts need a published schema, and a referenced contract needs a
 * runtime that actually produces it.
 */
export function contractReferenceDiagnostics(
  entries: Iterable<PluginRegistryEntry>,
): string[] {
  const loaded = [...entries].filter((entry) => entry.status !== "error");
  const schemas = new Set(
    loaded.flatMap((entry) =>
      Object.keys(entry.packageManifest?.contractSchemas ?? {}),
    ),
  );
  const providers = new Map<string, string[]>();
  for (const entry of loaded)
    for (const provided of entry.packageManifest?.plugin?.provides ?? []) {
      const contract =
        typeof provided === "string" ? provided : provided.contract;
      providers.set(contract, [...(providers.get(contract) ?? []), entry.id]);
    }
  const runtimes = loaded.flatMap((entry) =>
    pluginRuntimeManifests(entry).map((parsed) => parsed.manifest),
  );
  const producedByPlugin = new Map(
    loaded.map((entry) => [
      entry.id,
      new Set(
        pluginRuntimeManifests(entry).flatMap(({ manifest }) =>
          manifest.outputContract ? [manifest.outputContract] : [],
        ),
      ),
    ]),
  );
  const messages = new Set<string>();
  for (const runtime of runtimes) {
    const references: { contract: string; field: string; data: boolean }[] = [
      ...Object.entries(runtime.inputs ?? {}).flatMap(([name, binding]) =>
        "capability" in binding.from
          ? [
              {
                contract: binding.from.capability,
                field: `inputs.${name}`,
                data: true,
              },
            ]
          : [],
      ),
      ...(runtime.needs ?? []).flatMap((need) =>
        typeof need === "object" && "capability" in need
          ? [{ contract: need.capability, field: "needs", data: false }]
          : [],
      ),
      ...(runtime.input?.inject ?? []).flatMap((binding) =>
        binding.kind === "runtime-export" && "capability" in binding.from
          ? [
              {
                contract: binding.from.capability,
                field: `input.inject.${binding.name}`,
                data: true,
              },
            ]
          : [],
      ),
    ];
    for (const { contract, field, data } of references) {
      if (isKernelExtensionContract(contract)) continue;
      if (data && !schemas.has(contract))
        messages.add(
          `contract ${contract} consumed by ${runtime.name} ${field} has no published schema; provider output is not validated`,
        );
      const missingOwners = (providers.get(contract) ?? []).filter(
        (owner) => !producedByPlugin.get(owner)?.has(contract),
      );
      if (missingOwners.length)
        messages.add(
          `contract ${contract} referenced by ${runtime.name} ${field} is provided by ${missingOwners.join(", ")} but no runtime in those plugins declares io.output.contract ${contract}; selecting those providers cannot satisfy the reference`,
        );
    }
  }
  return [...messages];
}
