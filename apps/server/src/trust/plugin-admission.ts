import type { Context } from "hono";
import {
  packageFileSignature,
  type PluginExecutionProof,
} from "@covel/plugin-loader";
import {
  hostProfileOf,
  isOperatorRequest,
  type HostProfile,
} from "../host-profile.js";
import type { PermissionService } from "./permission-service.js";
import type { TrustedSourceService } from "./trusted-source-service.js";

export type DeclarativeAdmissionDecision = "allow" | "ask" | "deny";

/**
 * Sync decision for a statically declarative package:
 * - `null` when the package is not verified declarative
 * - `"allow"` when waived automatically by `plugin.declarative`
 * - `"ask"` when player approval is required
 * - `"deny"` when hard-blocked by L1/L2/L3 `plugin.declarative`
 */
export function declarativeAdmissionDecision(
  trust: TrustedSourceService | undefined,
  permissionService: PermissionService | undefined,
  pluginId: string,
  profile?: HostProfile,
  isOperator = false,
): DeclarativeAdmissionDecision | null {
  if (!trust?.isDeclarative(pluginId)) return null;
  if (!permissionService) return "allow";
  return permissionService.evaluateCapabilityForPlugin(
    "plugin.declarative",
    pluginId,
    profile,
    isOperator,
  ).effective;
}

/** Sync check: package is verified declarative AND allowed by `plugin.declarative` policy. */
export function isDeclarativeAdmitted(
  trust: TrustedSourceService | undefined,
  permissionService: PermissionService | undefined,
  pluginId: string,
  profile?: HostProfile,
  isOperator = false,
): boolean {
  return (
    declarativeAdmissionDecision(
      trust,
      permissionService,
      pluginId,
      profile,
      isOperator,
    ) === "allow"
  );
}

/** Eligibility waives only package activation and runtime approvals, never a grant. */
export async function refreshDeclarativeEligibility(
  trust: TrustedSourceService | undefined,
  pluginId: string,
  permissionService?: PermissionService,
  options?: {
    readonly profile?: HostProfile;
    readonly isOperator?: boolean;
  },
): Promise<boolean> {
  await trust?.ensureFresh(pluginId);
  return isDeclarativeAdmitted(
    trust,
    permissionService,
    pluginId,
    options?.profile,
    options?.isOperator ?? false,
  );
}

/**
 * Route-level declarative admission check:
 * - Refreshes package integrity first unless `options.refresh === false`.
 * - Returns `{ admitted: false, denied }` with 403/401 when a statically
 *   declarative package is explicitly denied by L1/L2/L3 `plugin.declarative`.
 * - Returns `{ admitted: false }` without `denied` when `plugin.declarative`
 *   is `"ask"` (requiring approval) or the package is not declarative.
 */
export async function evaluateDeclarativeRouteAdmission(
  c: Context,
  trust: TrustedSourceService | undefined,
  permissionService: PermissionService | undefined,
  pluginId: string,
  options?: { readonly refresh?: boolean },
): Promise<
  | { readonly admitted: true }
  | { readonly admitted: false; readonly denied?: Response }
> {
  if (options?.refresh !== false) {
    await trust?.ensureFresh(pluginId);
  }
  if (!trust?.isDeclarative(pluginId)) {
    return { admitted: false };
  }
  const denied = permissionService?.requireCapabilityForPlugin(
    c,
    "plugin.declarative",
    pluginId,
  );
  if (denied) {
    return { admitted: false, denied };
  }
  const profile = hostProfileOf(c);
  return {
    admitted: permissionService
      ? permissionService.isCapabilityAllowedForPlugin(
          "plugin.declarative",
          pluginId,
          profile,
          isOperatorRequest(c, profile),
        )
      : true,
  };
}

/** Reload candidates have not been published in the registry yet. */
export async function hasFreshDeclarativeProof(
  root: string,
  proof: PluginExecutionProof | undefined,
): Promise<boolean> {
  if (proof?.mode !== "declarative" || !proof.signature || !proof.digest)
    return false;
  return (
    proof.signature ===
    (await packageFileSignature(root).catch(() => undefined))
  );
}
