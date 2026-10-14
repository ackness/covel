/**
 * Framework-origin proposal source.
 *
 * When the kernel/API itself emits a proposal — rather than a plugin runtime —
 * it must still populate `Proposal.source` (a required `{ pluginId, runtimeId }`).
 *
 * The framework↔plugin isolation rule forbids framework code from hard-coding a
 * *concrete plugin id*. `FRAMEWORK_PLUGIN_ID` is not a plugin: it is the ID
 * reserved for the framework, which no package may take, and the RPC layer
 * uses it for framework-default actions. Reusing it here
 * keeps API-originated writes attributable in traces (`runtimeId` is used only
 * for trace/log keys; `character.upsert` is session-scoped, so `pluginId` is not
 * used for data isolation) without inventing a fake plugin identity.
 */
import { FRAMEWORK_PLUGIN_ID, type ProposalSource } from "@covel/shared";

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
