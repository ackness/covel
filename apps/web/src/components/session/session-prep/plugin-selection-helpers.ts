import type * as api from "@/services/api.js";

type AuthorizationFacts = Pick<
  api.PluginSummary,
  "source" | "executionMode" | "trust"
>;

/**
 * Whether a package may join a session without a new player approval: bundled,
 * freshly verified declarative, or covered by the instance's trusted sources.
 * The server applies the same rule when it resolves a session's plugins.
 */
export function isAuthorizedPackage(pkg: AuthorizationFacts): boolean {
  return (
    pkg.source === "builtin" ||
    pkg.executionMode === "declarative" ||
    pkg.trust?.autoApproved === true
  );
}

/** `kind: core` packages start selected whenever the player could add them. */
export function isDefaultPackage(
  pkg: Pick<api.PluginSummary, "kind"> & AuthorizationFacts,
): boolean {
  return pkg.kind === "core" && isAuthorizedPackage(pkg);
}

export function requiredPluginIdsForWorld(
  plan: api.WorldPluginPlan | null,
): Set<string> {
  return new Set(plan?.selection.requestedPluginIds ?? []);
}
