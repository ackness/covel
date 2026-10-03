import type { ExtensionDeclaration } from "./extension-points/index.js";
import {
  kernelExtensionPoints,
  isKernelExtensionContract,
  INVALID_KERNEL_CONFLICT,
  kernelConflictMessage,
} from "./extension-points/contracts.js";
import type { PluginManifest } from "./types/plugin-manifest.js";

export interface SessionPluginCandidate {
  readonly id: string;
  readonly kind: "core" | "plugin";
  readonly source: "builtin" | "community";
  readonly authorized: boolean;
  readonly provides?: PluginManifest["provides"];
  readonly requires?: readonly string[];
  readonly optional?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly extensions?: readonly ExtensionDeclaration[];
}
export interface PluginResolutionRejection {
  readonly pluginId: string;
  readonly code:
    | typeof INVALID_KERNEL_CONFLICT
    | "unknown-plugin"
    | "approval-required"
    | "excluded"
    | "missing-provider"
    | "ambiguous-provider"
    | "conflict"
    | "single-provider-conflict"
    | "default-replaced";
  readonly reason: string;
  readonly candidates?: readonly string[];
  readonly path?: readonly (string | number)[];
}
/** A contract the session's world requires that no active plugin provides. */
export interface UnmetWorldRequirement {
  readonly contract: string;
  readonly code:
    | "missing-provider"
    | "ambiguous-provider"
    | "approval-required"
    | "excluded";
  readonly candidates?: readonly string[];
}
export interface SessionPluginResolution {
  readonly active: string[];
  readonly autoAdded: string[];
  readonly rejected: PluginResolutionRejection[];
  readonly unmet: UnmetWorldRequirement[];
}
/** Requirements that are a setup problem rather than a choice the player made. */
export const isBlockingWorldRequirement = (item: UnmetWorldRequirement) =>
  item.code === "missing-provider" || item.code === "ambiguous-provider";
const singlePoints = new Set<string>(
  Object.values(kernelExtensionPoints)
    .filter((point) => point.mode === "single")
    .map((point) => point.id),
);
/** Kernel dependencies require implementations, not a root capability claim. */
const contracts = (plugin: SessionPluginCandidate): string[] => [
  ...(plugin.provides ?? [])
    .map((p) => (typeof p === "string" ? p : p.contract))
    .filter((contract) => !isKernelExtensionContract(contract)),
  ...(plugin.extensions ?? []).flatMap((extension) => [
    extension.point,
    ...(extension.point === kernelExtensionPoints.uiSlot.id && extension.slot
      ? [extension.slot]
      : []),
  ]),
];
const isDefault = (plugin: SessionPluginCandidate, contract: string) =>
  plugin.provides?.some(
    (p) => typeof p !== "string" && p.contract === contract && p.default,
  ) ?? false;

/** One deterministic authority for requested, excluded and dependency activation. */
export function resolveSessionPlugins(args: {
  readonly requested: readonly string[];
  readonly excluded?: readonly string[];
  readonly plugins: readonly SessionPluginCandidate[];
  /** Contracts the session's world needs; the world acts as one more requirer. */
  readonly requiredContracts?: readonly string[];
}): SessionPluginResolution {
  const registry = new Map(args.plugins.map((p) => [p.id, p]));
  const requested = new Set(args.requested);
  const worldRequired = [...new Set(args.requiredContracts ?? [])];
  const excluded = new Set(args.excluded ?? []);
  const rejected = new Map<string, PluginResolutionRejection>();
  const active = new Set<string>();
  const autoAdded = new Set<string>();
  const reject = (
    id: string,
    code: PluginResolutionRejection["code"],
    reason: string,
    candidates?: string[],
    path?: readonly (string | number)[],
  ) => {
    active.delete(id);
    autoAdded.delete(id);
    if (!rejected.has(id))
      rejected.set(id, {
        pluginId: id,
        code,
        reason,
        ...(candidates ? { candidates } : {}),
        ...(path ? { path } : {}),
      });
  };
  const eligible = (p: SessionPluginCandidate) =>
    !excluded.has(p.id) &&
    (p.source === "builtin" || p.authorized) &&
    !rejected.has(p.id);
  const add = (id: string, automatic: boolean) => {
    const p = registry.get(id);
    if (!p) {
      reject(id, "unknown-plugin", `Plugin ${id} is not installed`);
      return;
    }
    if (excluded.has(id)) {
      reject(id, "excluded", `Plugin ${id} was explicitly disabled`);
      return;
    }
    if (p.source !== "builtin" && !p.authorized) {
      reject(id, "approval-required", `Plugin ${id} requires approval`);
      return;
    }
    const invalidConflict =
      p.conflicts?.findIndex(isKernelExtensionContract) ?? -1;
    if (invalidConflict !== -1) {
      reject(
        id,
        INVALID_KERNEL_CONFLICT,
        kernelConflictMessage(p.conflicts![invalidConflict]!),
        undefined,
        ["conflicts", invalidConflict],
      );
      return;
    }
    active.add(id);
    if (automatic && !requested.has(id)) autoAdded.add(id);
  };
  const provided = (contract: string) =>
    [...active].some((id) => contracts(registry.get(id)!).includes(contract));
  /** The only explicit provider of a contract, else its only default one. */
  const chooseProvider = (contract: string) => {
    const candidates = args.plugins.filter(
      (candidate) =>
        eligible(candidate) && contracts(candidate).includes(contract),
    );
    const explicit = candidates.filter(
      (candidate) => !isDefault(candidate, contract),
    );
    const defaults = candidates.filter((candidate) =>
      isDefault(candidate, contract),
    );
    const choice =
      explicit.length === 1
        ? explicit[0]
        : defaults.length === 1
          ? defaults[0]
          : undefined;
    return { candidates, choice };
  };
  for (const id of requested) add(id, false);
  for (const p of args.plugins)
    if (p.kind === "core" && !active.has(p.id)) add(p.id, true);
  // World providers join before plugin dependencies resolve, so the loop below
  // also resolves what they require.
  for (const contract of worldRequired) {
    if (provided(contract)) continue;
    const { choice } = chooseProvider(contract);
    if (choice) add(choice.id, true);
  }

  // The active Set iterator includes newly added dependencies and terminates on cycles.
  for (const id of active) {
    const p = registry.get(id)!;
    for (const required of p.requires ?? []) {
      if (provided(required)) continue;
      const { candidates, choice } = chooseProvider(required);
      if (choice) add(choice.id, true);
      else {
        const awaitingApproval = args.plugins.filter(
          (candidate) =>
            !excluded.has(candidate.id) &&
            contracts(candidate).includes(required) &&
            candidate.source === "community" &&
            !candidate.authorized,
        );
        reject(
          id,
          candidates.length
            ? "ambiguous-provider"
            : awaitingApproval.length
              ? "approval-required"
              : "missing-provider",
          `Cannot resolve required contract ${required}`,
          (candidates.length ? candidates : awaitingApproval).map(
            (candidate) => candidate.id,
          ),
        );
        break;
      }
    }
  }
  for (const id of [...active]) {
    const p = registry.get(id)!;
    const replaced = (p.provides ?? []).find(
      (provided) =>
        typeof provided !== "string" &&
        provided.default &&
        [...active].some(
          (other) =>
            other !== id &&
            contracts(registry.get(other)!).includes(provided.contract) &&
            !isDefault(registry.get(other)!, provided.contract),
        ),
    );
    if (replaced)
      reject(id, "default-replaced", `A non-default provider replaces ${id}`);
  }
  // Explicit requests precede dependencies; ties retain stable request/catalog order.
  const ordered = [...active].sort(
    (a, b) => Number(!requested.has(a)) - Number(!requested.has(b)),
  );
  const accepted: string[] = [];
  for (const id of ordered) {
    const p = registry.get(id)!;
    const conflict = accepted.find((other) => {
      const q = registry.get(other)!;
      return (
        (p.conflicts ?? []).some((c) => contracts(q).includes(c)) ||
        (q.conflicts ?? []).some((c) => contracts(p).includes(c))
      );
    });
    if (conflict) {
      reject(id, "conflict", `Conflicts with ${conflict}`);
      continue;
    }
    const duplicate = accepted.find((other) =>
      p.extensions?.some(
        (extension) =>
          singlePoints.has(extension.point) &&
          registry
            .get(other)!
            .extensions?.some(
              (otherExtension) => otherExtension.point === extension.point,
            ),
      ),
    );
    if (duplicate) {
      reject(
        id,
        "single-provider-conflict",
        `Single extension point already provided by ${duplicate}`,
      );
      continue;
    }
    accepted.push(id);
  }
  // Provider removals can invalidate a transitive consumer. Never re-add an excluded
  // or conflict loser to repair the graph; report all resulting rejections instead.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...active]) {
      const missing = registry
        .get(id)!
        .requires?.find(
          (required) =>
            ![...active].some((candidate) =>
              contracts(registry.get(candidate)!).includes(required),
            ),
        );
      if (missing) {
        const pending = args.plugins.filter(
          (provider) =>
            contracts(provider).includes(missing) &&
            rejected.get(provider.id)?.code === "approval-required",
        );
        reject(
          id,
          pending.length ? "approval-required" : "missing-provider",
          `Required contract ${missing} has no active provider`,
          pending.map((provider) => provider.id),
        );
        changed = true;
      }
    }
  }
  // A provider added only for the world has no requesting plugin; without this
  // seed it would be pruned as an orphaned dependency.
  const reachable = new Set(
    [...active].filter(
      (id) =>
        requested.has(id) ||
        registry.get(id)!.kind === "core" ||
        worldRequired.some((contract) =>
          contracts(registry.get(id)!).includes(contract),
        ),
    ),
  );
  for (const id of reachable)
    for (const required of registry.get(id)!.requires ?? [])
      for (const candidate of active)
        if (contracts(registry.get(candidate)!).includes(required))
          reachable.add(candidate);
  for (const id of active) if (!reachable.has(id)) active.delete(id);
  const ids = (plugins: readonly SessionPluginCandidate[]) =>
    plugins.map((plugin) => plugin.id);
  const unmet = worldRequired.flatMap((contract): UnmetWorldRequirement[] => {
    if (provided(contract)) return [];
    const providers = args.plugins.filter((plugin) =>
      contracts(plugin).includes(contract),
    );
    if (providers.length === 0) return [{ contract, code: "missing-provider" }];
    const allowed = providers.filter((plugin) => !excluded.has(plugin.id));
    if (allowed.length === 0)
      return [{ contract, code: "excluded", candidates: ids(providers) }];
    const usable = allowed.filter(eligible);
    if (usable.length > 1)
      return [
        { contract, code: "ambiguous-provider", candidates: ids(usable) },
      ];
    const pending = allowed.filter(
      (plugin) => plugin.source === "community" && !plugin.authorized,
    );
    if (pending.length > 0)
      return [
        { contract, code: "approval-required", candidates: ids(pending) },
      ];
    // Installed and allowed, but dropped by a conflict or its own dependency.
    return [{ contract, code: "missing-provider", candidates: ids(allowed) }];
  });
  return {
    active: [...active],
    autoAdded: [...autoAdded].filter((id) => active.has(id)),
    rejected: [...rejected.values()],
    unmet,
  };
}
