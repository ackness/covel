/**
 * Which commit units may be dropped alone, and which must be dropped for
 * what they stood on.
 *
 * A unit is a top-level result with the results nested under it; it commits
 * or drops as one. Next to a committed story, a unit without a story or setup
 * run commits in its own savepoint and may be dropped alone: for a rejected
 * write, for a hard upstream that was dropped (`commit-dependencies.ts`), or
 * for reading uncommitted plugin data of a dropped producer
 * (`read-dependencies.ts`). These decisions read no store.
 */

import { isSetupRuntime, type RuntimeManifest } from "@covel/shared";
import { droppedUpstream } from "./commit-dependencies.js";
import type { OperationEntry, OperationLedger } from "./operation-ledger.js";
import type { RanSetupRuntime } from "./setup-settle.js";
import type { FinalizableResult, IsolatedRuntime } from "./finalize-types.js";

/** Results as committed: a runtime whose writes were dropped reads as failed. */
export function applyIsolatedRuntimes<
  T extends {
    readonly runtimeId: string;
    readonly runId?: string;
    readonly status: string;
  },
>(
  results: readonly T[],
  isolated: readonly IsolatedRuntime[] | undefined,
): T[] {
  const byRun = new Map<string, string>();
  const byRuntime = new Map<string, string>();
  for (const item of isolated ?? []) {
    if (item.runId !== undefined) byRun.set(item.runId, item.error);
    else byRuntime.set(item.runtimeId, item.error);
  }
  return results.map((result) => {
    const error =
      (result.runId !== undefined ? byRun.get(result.runId) : undefined) ??
      byRuntime.get(result.runtimeId);
    return error !== undefined
      ? { ...result, status: "failed", error }
      : result;
  });
}

/** A top-level result and the nested results that commit or drop with it. */
export interface CommitUnit {
  /** The top-level result, last of `members`. */
  readonly root: FinalizableResult;
  /** Children before their parent, `root` last. */
  readonly members: readonly FinalizableResult[];
}

export function commitUnitsOf(
  results: readonly FinalizableResult[],
  sizes: readonly number[] | undefined,
): CommitUnit[] {
  if (!sizes) return results.map((root) => ({ root, members: [root] }));
  const units: CommitUnit[] = [];
  let start = 0;
  for (const size of sizes) {
    const members = results.slice(start, start + size);
    const root = members.at(-1);
    if (size < 1 || members.length !== size || !root) break;
    units.push({ root, members });
    start += size;
  }
  if (start !== results.length) {
    throw new Error(
      `commitUnits cover ${start} of ${results.length} results; the commit plan is malformed`,
    );
  }
  return units;
}

export interface IsolationPolicy {
  /** Whether a story runtime of the execution succeeded. */
  readonly hasStory: boolean;
  /** A story or setup run: its unit never drops on its own. */
  protects(result: FinalizableResult): boolean;
  /** Whether the unit commits in its own savepoint and may drop alone. */
  isolates(unit: CommitUnit): boolean;
}

export function isolationPolicy(input: {
  readonly results: readonly FinalizableResult[];
  readonly runtimes: readonly RuntimeManifest[];
  readonly setupRan?: readonly Pick<RanSetupRuntime, "runtimeId">[];
  /** The result's output kind, from its manifest. */
  readonly kindOf: (result: FinalizableResult) => string;
}): IsolationPolicy {
  const { results, runtimes, kindOf } = input;
  // A committed story must not be lost to an optional runtime's rejected
  // write. When the execution produced a story, every other non-setup unit
  // commits in its own savepoint: a rejection rolls back that unit alone.
  // Without a story (manual, background, detached, setup), the execution stays
  // all-or-nothing so a job never reports success for writes that did not land.
  const hasStory = results.some(
    (result) => kindOf(result) === "story" && result.status === "success",
  );
  // A setup run is known by its manifest's stage: `setupRan` lists only the
  // setup runtimes this execution scheduled, not one a parent called nested.
  const setupRuntimeIds = new Set([
    ...(input.setupRan ?? []).map((ran) => ran.runtimeId),
    ...runtimes.filter(isSetupRuntime).map((runtime) => runtime.name),
  ]);
  const protects = (result: FinalizableResult): boolean =>
    kindOf(result) === "story" || setupRuntimeIds.has(result.runtimeId);
  // A unit holding a story or setup run anywhere, even nested, stays with the
  // execution: dropping it on its own could drop the very story that made
  // isolation safe.
  const isolates = (unit: CommitUnit): boolean =>
    hasStory && !unit.members.some(protects);
  return { hasStory, protects, isolates };
}

/** Why a unit's writes were dropped. */
export interface DropReason {
  readonly error: string;
  readonly cause: IsolatedRuntime["cause"];
}

/** Which runs were dropped, once every unit has committed or dropped. */
export interface SettledDrops {
  /** Every dropped run, nested ones included. */
  readonly runs: ReadonlySet<FinalizableResult>;
  /** The top-level runtime ids of the dropped units. */
  readonly rootIds: ReadonlySet<string>;
  readonly runIds: ReadonlySet<string>;
  /**
   * Whether the run `runId` was dropped; without a run id, whether a dropped
   * unit has the top-level runtime `runtimeId`.
   */
  runDropped(runId: string | undefined, runtimeId: string | undefined): boolean;
}

/** The units dropped at commit, in the order they dropped, and why. */
export class DroppedUnits {
  private readonly byUnit = new Map<CommitUnit, DropReason>();
  private view: SettledDrops | undefined;

  drop(unit: CommitUnit, reason: DropReason): void {
    this.byUnit.set(unit, reason);
    this.view = undefined;
  }

  get size(): number {
    return this.byUnit.size;
  }

  // Top-level runtime ids are unique within an execution, so dependency
  // checks, which only cross units at top level, can key on them.
  rootIds(): Set<string> {
    return new Set([...this.byUnit.keys()].map((unit) => unit.root.runtimeId));
  }

  runs(): Set<FinalizableResult> {
    return new Set([...this.byUnit.keys()].flatMap((unit) => unit.members));
  }

  /** One entry per dropped run, in commit order. */
  isolatedRuntimes(): IsolatedRuntime[] {
    return [...this.byUnit].flatMap(([unit, { error, cause }]) =>
      unit.members.map((member) => ({
        runtimeId: member.runtimeId,
        runId: member.runId,
        cause: member === unit.root ? cause : "nested",
        error:
          member === unit.root
            ? error
            : `dropped with ${unit.root.runtimeId}: ${error}`,
      })),
    );
  }

  /**
   * The dropped runs, read once every unit has committed or dropped. Every
   * step after the units reads the same view.
   */
  settled(): SettledDrops {
    if (this.view) return this.view;
    const runs = this.runs();
    const rootIds = this.rootIds();
    const runIds = new Set([...runs].map((run) => run.runId));
    this.view = {
      runs,
      rootIds,
      runIds,
      runDropped: (runId, runtimeId) =>
        runId !== undefined
          ? runIds.has(runId)
          : runtimeId !== undefined && rootIds.has(runtimeId),
    };
    return this.view;
  }
}

/** What a dropped producer a reader depended on was. */
export type LostRead =
  | { readonly reader: FinalizableResult; readonly producer: FinalizableResult }
  | { readonly reader: FinalizableResult; readonly operation: OperationEntry };

export function lostProducerName(lost: LostRead): string {
  return "operation" in lost
    ? lost.operation.record.contract
    : lost.producer.runtimeId;
}

export interface UnitDependencyInput {
  readonly runtimes: readonly RuntimeManifest[];
  /** The execution's results, in commit order. */
  readonly results: readonly FinalizableResult[];
  readonly units: readonly CommitUnit[];
  /** The writes each result has left to commit after preparation. */
  readonly prepared: ReadonlyMap<
    FinalizableResult,
    { readonly proposals: readonly unknown[] }
  >;
  /** Producer ids by reader `runId` (`FinalizeExecutionArgs.readDependencies`). */
  readonly readDependencies?: Readonly<Record<string, readonly string[]>>;
  /** The `runId` of the result each continuation came from. */
  readonly suspensionRuns?: Readonly<Record<string, string>>;
  readonly operations: Pick<OperationLedger, "entry" | "dropped">;
  /** Read at each check: the units dropped so far. */
  readonly drops: Pick<DroppedUnits, "rootIds" | "runs">;
}

export interface UnitDependencies {
  /** The hard upstream of the unit that was dropped, when one was. */
  lostUpstreamOf(unit: CommitUnit): string | undefined;
  /** The dropped producers outside the unit whose writes its members read. */
  lostReadsOf(unit: CommitUnit): LostRead[];
}

/** What each unit stood on, checked against the units dropped so far. */
export function unitDependencies(input: UnitDependencyInput): UnitDependencies {
  const { runtimes, results, units, prepared, operations, drops } = input;
  const manifestByRuntime = new Map(runtimes.map((rt) => [rt.name, rt]));
  // A unit stands on its top-level result's hard upstreams when that result
  // succeeded, and also when the unit has writes to commit whatever its
  // status: a guard that wrote and then returned `{ skip: true }` leaves a
  // skipped result with buffered writes. Nested results depend only on
  // results of their own nested execution, which sit in the same unit.
  const lostUpstreamOf = (unit: CommitUnit): string | undefined => {
    const manifest = manifestByRuntime.get(unit.root.runtimeId);
    return manifest &&
      (unit.root.status === "success" ||
        unit.members.some(
          (member) => prepared.get(member)!.proposals.length > 0,
        ))
      ? droppedUpstream(manifest, {
          runtimes,
          results: units.map((candidate) => candidate.root),
          dropped: drops.rootIds(),
        })
      : undefined;
  };
  // Producers precede their readers in commit order: a reader's visible
  // set is taken from results completed before it started, children
  // before their parent. Edges inside one unit are ignored, as the unit
  // commits or drops as one.
  const resultByRun = new Map(results.map((result) => [result.runId, result]));
  const positionOf = new Map(results.map((result, index) => [result, index]));
  // An operation commits at the end of its caller's unit.
  const unitRootOf = (member: FinalizableResult): FinalizableResult =>
    units.find((unit) => unit.members.includes(member))?.root ?? member;
  const continuationRuns = new Set(Object.values(input.suspensionRuns ?? {}));
  const lostReadsOf = (unit: CommitUnit): LostRead[] => {
    const edges = input.readDependencies;
    if (
      !edges ||
      !(
        unit.root.status === "success" ||
        unit.members.some((member) => continuationRuns.has(member.runId)) ||
        unit.members.some(
          (member) => prepared.get(member)!.proposals.length > 0,
        )
      )
    )
      return [];
    const members = new Set(unit.members);
    const dropped = drops.runs();
    const lost = new Map<FinalizableResult | OperationEntry, LostRead>();
    for (const reader of unit.members) {
      for (const producerId of edges[reader.runId] ?? []) {
        // A producer is a run or a write-service operation; an unknown id
        // has nothing to drop.
        const operation = operations.entry(producerId);
        if (!resultByRun.has(producerId) && operation) {
          if (members.has(operation.member)) continue;
          if (
            positionOf.get(unitRootOf(operation.member))! >
            positionOf.get(reader)!
          ) {
            console.warn(
              `[finalize-execution] ${reader.runtimeId} read data written through ${operation.record.contract}, which commits after it; the dependency is ignored`,
            );
            continue;
          }
          if (operations.dropped(operation) && !lost.has(operation))
            lost.set(operation, { reader, operation });
          continue;
        }
        const producer = resultByRun.get(producerId);
        if (!producer || members.has(producer)) continue;
        if (positionOf.get(producer)! > positionOf.get(reader)!) {
          console.warn(
            `[finalize-execution] ${reader.runtimeId} read data of ${producer.runtimeId}, which commits after it; the dependency is ignored`,
          );
          continue;
        }
        if (dropped.has(producer) && !lost.has(producer))
          lost.set(producer, { reader, producer });
      }
    }
    return [...lost.values()];
  };
  return { lostUpstreamOf, lostReadsOf };
}
