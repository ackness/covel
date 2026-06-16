/**
 * Framework-origin proposal source.
 *
 * When the kernel/API itself emits a proposal — rather than a plugin runtime —
 * it must still populate `Proposal.source` (a required `{ pluginId, runtimeId }`).
 *
 * The framework↔plugin isolation rule forbids framework code from hard-coding a
 * *concrete plugin id*. `"framework"` is not a plugin: it is the reserved
 * framework sentinel already used by the RPC layer for framework-default actions
 * (see `@covel/runtime` `rpc-registry.ts` / `rpc-defaults/*`). Reusing it here
 * keeps API-originated writes attributable in traces (`runtimeId` is used only
 * for trace/log keys; `character.upsert` is session-scoped, so `pluginId` is not
 * used for data isolation) without inventing a fake plugin identity.
 */
import type { ProposalSource } from "@covel/shared";

/** Reserved sentinel identifying the framework (not a plugin) as a write origin. */
export const FRAMEWORK_PLUGIN_ID = "framework";

/**
 * Build a framework-origin `ProposalSource`. `route` names the API surface that
 * produced the proposal (e.g. `"characters"`) so traces can tell framework
 * writes apart by endpoint.
 */
export function frameworkProposalSource(route: string): ProposalSource {
  return {
    pluginId: FRAMEWORK_PLUGIN_ID,
    runtimeId: `${FRAMEWORK_PLUGIN_ID}/${route}`,
  };
}
