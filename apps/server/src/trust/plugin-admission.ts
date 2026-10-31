import {
  packageFileSignature,
  type PluginExecutionProof,
} from "@covel/plugin-loader";
import type { TrustedSourceService } from "./trusted-source-service.js";

/** Eligibility waives only package activation and runtime approvals, never a grant. */
export async function refreshDeclarativeEligibility(
  trust: TrustedSourceService | undefined,
  pluginId: string,
): Promise<boolean> {
  await trust?.ensureFresh(pluginId);
  return trust?.isDeclarative(pluginId) ?? false;
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
