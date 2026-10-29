/** Commit handlers for plugin-data KV writes, deletes and operation lists. */

import {
  applyDataOps,
  pluginCodeNamespaceWriteError,
  type CommitResult,
  type DataOpKind,
  type DataOpsCurrent,
  type JsonValue,
  type ProposalFor,
} from "@covel/shared";
import { validateOutput } from "@covel/tools";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../media/canonicalize-media-refs.js";
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

/**
 * The commit rules of one declared dataset (`contributes.datasets`). `schema`
 * is the compiled record schema; it is absent when the host did not capture
 * the document, and every write into the namespace is then refused.
 */
export interface DatasetPolicy {
  readonly namespace: string;
  readonly ops: readonly DataOpKind[];
  readonly schema?: Readonly<Record<string, unknown>>;
}

/** The dataset policy of `(pluginId, namespace)`, or `undefined` when none is declared. */
export type DatasetPolicyResolver = (
  pluginId: string,
  namespace: string,
) => DatasetPolicy | undefined;

/** Compiled dataset record schemas: plugin id → namespace → schema. */
export type DatasetSchemas = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
>;

/**
 * The dataset resolver of one execution: `RuntimeManifest.datasets` (the same
 * on every runtime of a package) plus the schemas the plan captured. A
 * declared dataset without a captured schema gets a policy without `schema`,
 * which refuses every write. `undefined` when no runtime declares a dataset.
 */
export function datasetPolicyResolver(
  runtimes: readonly {
    readonly pluginId: string;
    readonly datasets?: Readonly<
      Record<
        string,
        { readonly namespace: string; readonly ops: readonly DataOpKind[] }
      >
    >;
  }[],
  schemas: DatasetSchemas = {},
): DatasetPolicyResolver | undefined {
  const byPlugin = new Map<string, Map<string, DatasetPolicy>>();
  for (const runtime of runtimes) {
    if (!runtime.datasets || byPlugin.has(runtime.pluginId)) continue;
    const policies = new Map<string, DatasetPolicy>();
    const pluginSchemas = Object.hasOwn(schemas, runtime.pluginId)
      ? schemas[runtime.pluginId]
      : undefined;
    for (const decl of Object.values(runtime.datasets)) {
      const schema =
        pluginSchemas && Object.hasOwn(pluginSchemas, decl.namespace)
          ? pluginSchemas[decl.namespace]
          : undefined;
      policies.set(decl.namespace, {
        namespace: decl.namespace,
        ops: decl.ops,
        ...(schema ? { schema } : {}),
      });
    }
    if (policies.size > 0) byPlugin.set(runtime.pluginId, policies);
  }
  if (byPlugin.size === 0) return undefined;
  return (pluginId, namespace) => byPlugin.get(pluginId)?.get(namespace);
}

export interface PluginDataCommitOptions {
  /** Enforces declared datasets; without it no namespace is checked. */
  readonly datasetPolicy?: DatasetPolicyResolver;
  /**
   * Canonicalizes the MediaRefs of a `plugin.data.update` result. The payload
   * check sees only the operations, and a reference can be assembled across
   * them or from the stored value, so the result is checked again.
   */
  readonly mediaStore?: MediaOwnershipStore;
}

const MAX_SCHEMA_ERRORS = 3;

/**
 * Dataset check of one plugin-data write: every operation kind must be
 * allowed, and a present resulting value must match the record schema. A
 * whole-value write counts as `set` and a delete as `delete`.
 */
function datasetFailure(
  proposalType: string,
  policy: DatasetPolicy | undefined,
  opKinds: readonly DataOpKind[],
  result?: { readonly value: unknown },
): CommitResult | undefined {
  if (!policy) return undefined;
  const fail = (message: string) =>
    commitError(`${proposalType}: ${message}`, "dataset-violation");
  if (!policy.schema)
    return fail(`dataset schema of ${policy.namespace} is unavailable`);
  const refused = opKinds.find((kind) => !policy.ops.includes(kind));
  if (refused !== undefined)
    return fail(
      `dataset ${policy.namespace}: operation kind ${refused} is not allowed`,
    );
  if (!result) return undefined;
  let check: ReturnType<typeof validateOutput>;
  try {
    check = validateOutput(result.value, policy.schema);
  } catch (error) {
    // A schema Ajv cannot compile is a data problem of this write, so it
    // rejects the proposal instead of rolling back the whole execution.
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`dataset ${policy.namespace}: schema is invalid (${reason})`);
  }
  if (check.valid) return undefined;
  const errors = (check.errors ?? []).slice(0, MAX_SCHEMA_ERRORS).join("; ");
  return fail(
    `dataset ${policy.namespace}: record does not match its schema (${errors})`,
  );
}

export function createPluginDataCommitHandlers(
  store: KernelStore,
  options: PluginDataCommitOptions = {},
): Pick<
  CommitHandlerMap,
  | "plugin.data"
  | "plugin.data.batch"
  | "plugin.data.delete"
  | "plugin.data.update"
> {
  const policyOf = (
    pluginId: string,
    namespace: unknown,
  ): DatasetPolicy | undefined =>
    typeof namespace === "string" && options.datasetPolicy
      ? options.datasetPolicy(pluginId, namespace)
      : undefined;

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
      datasetFailure(
        "plugin.data",
        policyOf(proposal.source.pluginId, payload.namespace),
        ["set"],
        { value: payload.value },
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
        datasetFailure(
          "plugin.data.batch",
          policyOf(proposal.source.pluginId, item.namespace),
          ["set"],
          { value: item.value },
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
      datasetFailure(
        "plugin.data.delete",
        policyOf(proposal.source.pluginId, payload.namespace),
        ["delete"],
      ),
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

  /**
   * Read-modify-write inside the commit transaction: the latest stored value
   * goes through `applyDataOps`, the same function the in-execution overlay
   * uses, and the result is checked and written back. Per-session commit
   * serialization keeps the read and the write together.
   */
  async function commitPluginDataUpdate(
    proposal: ProposalFor<"plugin.data.update">,
  ): Promise<CommitResult> {
    const type = "plugin.data.update";
    const payload = proposal.payload;
    const { getPluginData, setPluginData, deletePluginData } = store;
    if (!getPluginData || !setPluginData || !deletePluginData) {
      return commitError(`${type}: store does not support plugin data writes`);
    }
    const pluginId = proposal.source.pluginId;
    const policy = policyOf(pluginId, payload.namespace);
    const invalid = firstFailure(
      requireNonEmptyString(
        payload.namespace,
        `${type}: namespace must be a non-empty string`,
      ),
      requireNonEmptyString(
        payload.key,
        `${type}: key must be a non-empty string`,
      ),
      requireNonEmptyArray(
        payload.ops,
        `${type}: ops must be a non-empty array`,
      ),
      reservedNamespaceFailure(type, payload.namespace),
    );
    if (invalid) return invalid;
    const kinds = datasetFailure(
      type,
      policy,
      payload.ops.map((op) => op.op),
    );
    if (kinds) return kinds;

    const row = await getPluginData(
      proposal.sessionId,
      pluginId,
      payload.namespace,
      payload.key,
    );
    const current: DataOpsCurrent = row
      ? { exists: true, value: row.value as JsonValue }
      : { exists: false };
    const result = applyDataOps(current, payload.ops);
    if (!result.ok) {
      const { error } = result;
      const at = error.path !== undefined ? ` at ${error.path}` : "";
      return commitError(
        `${type}: ${error.message} (op ${error.opIndex}${at}, ${error.code})`,
        "data-op-rejected",
      );
    }
    if (!result.exists) {
      if (row) {
        await deletePluginData(
          proposal.sessionId,
          pluginId,
          payload.namespace,
          payload.key,
        );
      }
      return { committed: true };
    }
    let value: JsonValue = result.value;
    if (options.mediaStore) {
      const media = await canonicalizeMediaRefs(value, {
        store: options.mediaStore,
        sessionId: proposal.sessionId,
      });
      const [first] = media.rejections;
      if (first) {
        return commitError(
          `${type}: ${media.rejections.map((rejection) => rejection.message).join("; ")}`,
          first.reason,
        );
      }
      value = media.value;
    }
    const resultInvalid = firstFailure(
      oversizedValueFailure(
        type,
        pluginId,
        payload.namespace,
        payload.key,
        value,
      ),
      datasetFailure(type, policy, [], { value }),
    );
    if (resultInvalid) return resultInvalid;

    await setPluginData({
      id: crypto.randomUUID(),
      sessionId: proposal.sessionId,
      pluginId,
      namespace: payload.namespace,
      key: payload.key,
      value,
      createdAt: proposal.timestamp,
      updatedAt: proposal.timestamp,
    });
    return { committed: true };
  }

  return {
    "plugin.data": commitPluginData,
    "plugin.data.batch": commitPluginDataBatch,
    "plugin.data.delete": commitPluginDataDelete,
    "plugin.data.update": commitPluginDataUpdate,
  };
}
