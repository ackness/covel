/** Shared destination rules for runtime, RPC and imported plugin data. */
import type { CommitResult, DataOpKind } from "@covel/shared";
import { validateOutput } from "@covel/tools";
import { commitError } from "./commit/commit-validators.js";

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
 * The dataset resolver of captured package declarations and schema documents. A
 * declared dataset without a captured schema gets a policy without `schema`,
 * which refuses every write. `undefined` when no package declares a dataset.
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

const MAX_SCHEMA_ERRORS = 3;

/**
 * Dataset check of one plugin-data write: every operation kind must be
 * allowed, and a present resulting value must match the record schema. A
 * whole-value write counts as `set` and a delete as `delete`.
 */
export function datasetFailure(
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
