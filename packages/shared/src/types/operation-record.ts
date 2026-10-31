/**
 * Operation records: what one successful write-service call staged, and how
 * its writes ended at commit.
 *
 * A write service changes its provider's own data on behalf of a caller. The
 * call stages its writes as one operation, which rides on the calling run's
 * result and commits with the caller's commit unit. Each operation leaves a
 * record on that result (`RuntimeResult.operations`), persisted with the
 * execution's `turn_results` rows and settled inside the commit transaction.
 */

import type { JsonValue } from "./runtime-scheduling.js";

/** Where an operation is: staged with its caller, then settled at commit. */
export type OperationStatus = "staged" | "committed" | "failed" | "discarded";

/**
 * Why an operation did not commit.
 *
 * - `rejected`: one of its writes was refused (a hook veto, a dataset rule,
 *   the execution's proposal guard).
 * - `conflict`: one of its operation lists no longer applies to the value
 *   another commit left behind.
 * - `caller-dropped`: the code that called it failed, or its commit unit was
 *   dropped.
 * - `execution-failed`: the whole execution rolled back.
 * - `store-unsupported`: the store cannot isolate it next to a story.
 */
export type OperationFailureReason =
  | "rejected"
  | "conflict"
  | "caller-dropped"
  | "execution-failed"
  | "store-unsupported";

export interface OperationRecord {
  /** Kernel identity; producer id of the reads that saw its writes. */
  readonly id: string;
  /** The service's contract, e.g. `inventory.change@1`. */
  readonly contract: string;
  readonly providerPluginId: string;
  /** The provider's service name. */
  readonly service: string;
  /** The runtime whose code made the call. */
  readonly invokedBy: {
    readonly pluginId: string;
    readonly runtimeId: string;
  };
  /** The tool call that made the call, for calls made from a tool. */
  readonly toolCallId?: string;
  /** Call order within the execution; operations of a unit commit in it. */
  readonly seq: number;
  readonly status: OperationStatus;
  readonly reason?: OperationFailureReason;
  /** Model-facing text of the request and result, at most 300 characters. */
  readonly summary: string;
  /** The call's input as a model may read it; absent when too large. */
  readonly request?: JsonValue;
  /** The call's output as a model may read it; absent when too large. */
  readonly result?: JsonValue;
  /** Set when `request` or `result` was left out for its size (over 4 KB of JSON). */
  readonly truncated?: true;
}

/** The final status of one operation, applied by id to persisted records. */
export interface OperationSettlement {
  readonly id: string;
  readonly status: OperationStatus;
  readonly reason?: OperationFailureReason;
}
