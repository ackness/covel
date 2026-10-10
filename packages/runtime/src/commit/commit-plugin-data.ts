/** Commit handlers for plugin-data KV writes and deletes. */

import {
  pluginCodeNamespaceWriteError,
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
import { pluginDataSizeError } from "@covel/shared";

/**
 * Proposals carry plugin-authored namespaces, so the commit boundary rejects
 * framework namespaces. Writes are keyed by the source plugin, so the only
 * `_` namespaces it accepts are that plugin's own `_hidden.*` buckets; the LLM
 * plugin-data tools refuse those before a proposal exists. Framework writers
 * (job runner, runtime logger) bypass proposals and reach the store directly.
 */
function reservedNamespaceFailure(
  proposalType: string,
  namespace: unknown,
): CommitResult | undefined {
  if (typeof namespace !== "string") return undefined;
  const reserved = pluginCodeNamespaceWriteError(namespace);
  return reserved ? commitError(`${proposalType}: ${reserved}`) : undefined;
}

function oversizedValueFailure(
  proposalType: string,
  pluginId: string,
  namespace: string,
  key: string,
  value: unknown,
): CommitResult | undefined {
  const error = pluginDataSizeError(pluginId, namespace, key, value);
  return error ? commitError(`${proposalType}: ${error}`) : undefined;
}

export function createPluginDataCommitHandlers(
  store: KernelStore,
): Pick<
  CommitHandlerMap,
  "plugin.data" | "plugin.data.batch" | "plugin.data.delete"
> {
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
      oversizedValueFailure(
        "plugin.data",
        proposal.source.pluginId,
        payload.namespace,
        payload.key,
        payload.value,
      ),
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
        oversizedValueFailure(
          "plugin.data.batch",
          proposal.source.pluginId,
          item.namespace,
          item.key,
          item.value,
        ),
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

  async function commitPluginDataDelete(
    proposal: ProposalFor<"plugin.data.delete">,
  ): Promise<CommitResult> {
    const payload = proposal.payload;
    const deletePluginData = store.deletePluginData;
    if (!deletePluginData) {
      return commitError(
        "plugin.data.delete: store does not support plugin data deletes",
      );
    }
    const invalid = firstFailure(
      requireNonEmptyString(
        payload.namespace,
        "plugin.data.delete: namespace must be a non-empty string",
      ),
      requireNonEmptyString(
        payload.key,
        "plugin.data.delete: key must be a non-empty string",
      ),
      reservedNamespaceFailure("plugin.data.delete", payload.namespace),
    );
    if (invalid) return invalid;

    await deletePluginData(
      proposal.sessionId,
      proposal.source.pluginId,
      payload.namespace,
      payload.key,
    );
    return { committed: true };
  }

  return {
    "plugin.data": commitPluginData,
    "plugin.data.batch": commitPluginDataBatch,
    "plugin.data.delete": commitPluginDataDelete,
  };
}
