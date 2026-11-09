/**
 * The write-service operations of one execution and how each one ends.
 *
 * An operation rides on the result of the run that called it. It starts
 * `staged` when it can still commit (staged by the provider, with writes, on a
 * result whose own writes may commit) and `discarded` otherwise. The commit
 * then settles each staged one; the final states are saved with the
 * `turn_results` rows and returned in the outcome.
 */

import type {
  OperationFailureReason,
  OperationRecord,
  OperationSettlement,
  OperationStatus,
  Proposal,
} from "@covel/shared";
import {
  commitEligibility,
  type FailedProposal,
} from "../session/session-runtime-result.js";
import { malformedDomainEffect } from "./session-output-normalizer.js";
import type {
  FinalizableResult,
  FinalizedOperation,
} from "./finalize-types.js";

/** One write-service operation and the run that called it. */
export interface OperationEntry {
  readonly record: OperationRecord;
  /** Its staged writes, carrying the provider's identity. */
  readonly writes: readonly Proposal[];
  readonly member: FinalizableResult;
}

export class OperationLedger {
  /** Every operation a result carries, in result order. */
  readonly entries: readonly OperationEntry[];
  private readonly byId: ReadonlyMap<string, OperationEntry>;
  /** Records of the execution that no result carries. */
  private readonly abandoned: readonly OperationRecord[];
  private readonly state = new Map<
    string,
    { status: OperationStatus; reason?: OperationFailureReason }
  >();

  /**
   * `operationRecords` are the execution-wide records, including those of
   * recursive runs a parent abandoned, which no result carries.
   */
  constructor(
    results: readonly FinalizableResult[],
    operationRecords: readonly OperationRecord[] | undefined,
  ) {
    // Write-service operations, with the run that called them. Only a staged
    // operation of a result whose own writes may commit can commit.
    this.entries = results.flatMap((member) =>
      (member.operations ?? []).map((record) => ({
        record,
        writes: member.operationWrites?.[record.id] ?? [],
        member,
      })),
    );
    this.byId = new Map(this.entries.map((entry) => [entry.record.id, entry]));
    this.abandoned = (operationRecords ?? []).filter(
      (record) => !this.byId.has(record.id),
    );
    for (const entry of this.entries) {
      const committable =
        entry.record.status === "staged" &&
        entry.writes.length > 0 &&
        commitEligibility(entry.member) !== "none" &&
        !malformedDomainEffect(entry.member.effects);
      if (committable) this.settle(entry, "staged");
      else
        this.settle(
          entry,
          "discarded",
          entry.record.reason ?? "caller-dropped",
        );
    }
  }

  /** The operation a result carries with this id. */
  entry(id: string): OperationEntry | undefined {
    return this.byId.get(id);
  }

  settle(
    entry: OperationEntry,
    status: OperationStatus,
    reason?: OperationFailureReason,
  ): void {
    this.state.set(entry.record.id, {
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  statusOf(entry: OperationEntry): OperationStatus | undefined {
    return this.state.get(entry.record.id)?.status;
  }

  /** Whether the operation's writes did not, or will not, land. */
  dropped(entry: OperationEntry): boolean {
    const status = this.statusOf(entry);
    return status === "failed" || status === "discarded";
  }

  /** Operations of `members` that can still commit, in call order. */
  stagedOf(members: readonly FinalizableResult[]): OperationEntry[] {
    const set = new Set(members);
    return this.entries
      .filter(
        (entry) => set.has(entry.member) && this.statusOf(entry) === "staged",
      )
      .sort((a, b) => a.record.seq - b.record.seq);
  }

  /**
   * Every operation of the execution, abandoned ones included, in call order,
   * with how it ended. `override` replaces every state (a rolled-back
   * execution); an operation never settled ends `discarded`.
   */
  finalized(
    override?: Pick<FinalizedOperation, "status" | "reason">,
  ): FinalizedOperation[] {
    return [...this.entries.map((entry) => entry.record), ...this.abandoned]
      .sort((a, b) => a.seq - b.seq)
      .map((record) => {
        const state = override ??
          this.state.get(record.id) ?? {
            status: "discarded" as const,
            reason: "caller-dropped" as const,
          };
        return {
          id: record.id,
          status: state.status,
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
          contract: record.contract,
          invokedBy: record.invokedBy,
        };
      });
  }
}

/** The settlements saved with the `turn_results` rows. */
export function settlementsOf(
  finalized: readonly FinalizedOperation[],
): OperationSettlement[] {
  return finalized.map(({ id, status, reason }) => ({
    id,
    status,
    ...(reason !== undefined ? { reason } : {}),
  }));
}

/** The failure reason of an operation whose writes were refused. */
export function operationFailureReason(
  failed: readonly FailedProposal[],
): OperationFailureReason {
  return failed.some((item) => item.code === "conflict")
    ? "conflict"
    : "rejected";
}

/**
 * An operation's `update` that the commit could not apply passed the same
 * check when it was staged: the value moved since. That is a conflict, not a
 * faulty write of the provider.
 */
export function asOperationFailures(
  failed: readonly FailedProposal[],
): FailedProposal[] {
  return failed.map((item) =>
    item.code === "data-op-rejected" &&
    item.proposal.type === "plugin.data.update"
      ? { ...item, code: "conflict" }
      : item,
  );
}
