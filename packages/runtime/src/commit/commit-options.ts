/**
 * The options each result's writes are prepared and committed with: the
 * execution's hooks, guards, media and dataset checks, and the buffer that
 * holds their post-commit fan-out.
 */

import { presentationCommitGuard } from "../presentation/commit.js";
import { datasetPolicyResolver } from "../plugin-data-validation.js";
import type { RuntimeCommitOptions } from "../session/session-runtime-result.js";
import type { OperationEntry } from "./operation-ledger.js";
import type {
  FinalizableResult,
  FinalizeExecutionArgs,
} from "./finalize-types.js";

type DeferPostCommit = (fn: () => Promise<void>) => void;

export interface CommitOptions {
  /** The result's output kind; `system` when its manifest declares none. */
  kindOf(result: FinalizableResult): string;
  /** Options for a result's own writes. */
  forResult(
    result: FinalizableResult,
    deferPostCommit?: DeferPostCommit,
  ): RuntimeCommitOptions;
  /** Options for an operation's writes, which the image flow never governs. */
  forOperation(
    entry: OperationEntry,
    deferPostCommit?: DeferPostCommit,
  ): RuntimeCommitOptions;
}

export function commitOptionsFor(args: FinalizeExecutionArgs): CommitOptions {
  const { runtimes, results, hookPipeline, eventBus, emitter } = args;
  const executionContext = args.executionContext;
  const outputKindByRuntime = new Map<string, string>();
  for (const rt of runtimes) {
    outputKindByRuntime.set(rt.name, rt.outputKind ?? "system");
  }
  // Providers of write services are checked like packages that ran, also
  // when none of their runtimes did.
  const providerDatasets = Object.entries(args.providerDatasets ?? {});
  const datasetPolicy = datasetPolicyResolver(
    [
      ...runtimes,
      ...providerDatasets.map(([pluginId, { datasets }]) => ({
        pluginId,
        datasets,
      })),
    ],
    {
      ...Object.fromEntries(
        providerDatasets.map(([pluginId, { schemas }]) => [pluginId, schemas]),
      ),
      ...args.datasetSchemas,
    },
  );
  const commitOpts = (
    result: FinalizableResult,
    deferPostCommit?: DeferPostCommit,
  ): RuntimeCommitOptions => ({
    ...(args.signal ? { signal: args.signal } : {}),
    ...(hookPipeline ? { hookPipeline } : {}),
    ...(eventBus ? { eventBus } : {}),
    ...(emitter ? { emitter } : {}),
    enforceImageFlow: args.imageFlowRuntimeIds?.includes(result.runtimeId),
    // A scoped retry repairs existing content unless it actually commits a
    // replacement story. Do not confuse this anchor with logical-turn counting.
    ...(executionContext.sourceTurnId &&
    !results.some(
      (candidate) =>
        candidate.turnId === result.turnId &&
        candidate.status === "success" &&
        outputKindByRuntime.get(candidate.runtimeId) === "story",
    )
      ? { messageSourceTurnId: executionContext.sourceTurnId }
      : {}),
    ...(runtimes.find((runtime) => runtime.name === result.runtimeId)
      ?.presentation
      ? {
          proposalGuard: presentationCommitGuard(
            runtimes.find((runtime) => runtime.name === result.runtimeId)!,
            result,
            args.proposalGuard,
          ),
        }
      : args.proposalGuard
        ? { proposalGuard: args.proposalGuard }
        : {}),
    ...(args.mediaStore ? { mediaStore: args.mediaStore } : {}),
    ...(datasetPolicy ? { datasetPolicy } : {}),
    ...(deferPostCommit ? { deferPostCommit } : {}),
  });
  return {
    kindOf: (result) => outputKindByRuntime.get(result.runtimeId) ?? "system",
    forResult: commitOpts,
    forOperation: (entry, deferPostCommit) => ({
      ...commitOpts(entry.member, deferPostCommit),
      enforceImageFlow: false,
    }),
  };
}
