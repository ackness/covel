/** Commit handlers for `plugin.data` and `plugin.data.batch` KV writes. */

import {
  reservedPluginDataNamespaceError,
  type CommitResult,
  type ProposalFor,
} from "@covel/shared";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";
import {
  commitError,
  firstFailure,
  requireNonEmptyArray,
  requireNonEmptyString,
} from "./commit-validators.js";

/**
 * Proposals carry plugin-authored namespaces, so the commit boundary applies
 * the same framework-namespace guard as the REST write API. Framework writers
 * (job runner, runtime logger) bypass proposals and reach the store directly.
 */
function reservedNamespaceFailure(
  proposalType: string,
  namespace: unknown,
): CommitResult | undefined {
  if (typeof namespace !== "string") return undefined;
  const reserved = reservedPluginDataNamespaceError(namespace);
  return reserved ? commitError(`${proposalType}: ${reserved}`) : undefined;
}

export function createPluginDataCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "plugin.data" | "plugin.data.batch"> {
  async function commitPluginData(
    proposal: ProposalFor<"plugin.data">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const setPluginData = store.setPluginData;
    if (!setPluginData) {
      return commitError(
        "plugin.data: store does not support plugin data writes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyString(
        payload.namespace,
        "plugin.data: namespace must be a non-empty string",
      ),
      requireNonEmptyString(
        payload.key,
        "plugin.data: key must be a non-empty string",
      ),
      reservedNamespaceFailure("plugin.data", payload.namespace),
    );
    if (invalid) return invalid;

    await setPluginData({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      pluginId: proposal.source.pluginId,
      namespace: payload.namespace,
      key: payload.key,
      value: payload.value,
      createdAt: proposal.timestamp,
      updatedAt: proposal.timestamp,
    });

    return { committed: true };
  }

  async function commitPluginDataBatch(
    proposal: ProposalFor<"plugin.data.batch">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const setPluginDataBatch = store.setPluginDataBatch;
    if (!setPluginDataBatch) {
      return commitError(
        "plugin.data.batch: store does not support plugin data writes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyArray(
        payload.items,
        "plugin.data.batch: items must be a non-empty array",
      ),
    );
    if (invalid) return invalid;

    const records = [];
    for (const item of payload.items) {
      const itemInvalid = firstFailure(
        requireNonEmptyString(
          item.namespace,
          "plugin.data.batch: every item needs a non-empty namespace",
        ),
        requireNonEmptyString(
          item.key,
          "plugin.data.batch: every item needs a non-empty key",
        ),
        reservedNamespaceFailure("plugin.data.batch", item.namespace),
      );
      if (itemInvalid) return itemInvalid;
      records.push({
        id: crypto.randomUUID(),
        sessionId: proposal.sessionId,
        pluginId: proposal.source.pluginId,
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: proposal.timestamp,
        updatedAt: proposal.timestamp,
      });
    }

    await setPluginDataBatch(records);
    return { committed: true };
  }

  return {
    "plugin.data": commitPluginData,
    "plugin.data.batch": commitPluginDataBatch,
  };
}
