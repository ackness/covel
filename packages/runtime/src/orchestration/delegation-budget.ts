import { PrivateDelegationProjection } from "./private-projections.js";
import {
  delegationSnapshotSchema,
  normalizeOrchestrationSettings,
  type NormalizedOrchestrationSettings,
  type TurnPolicyOutput,
} from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { CharacterHistoryReader } from "./character-history.js";

import type { DelegationSnapshot } from "@covel/shared";

/** Host-owned admission state, shared by recursive work and suspended legs. */
export class DelegationBudget {
  /** Reuse the row that froze preferences when the pipeline builds its context. */
  readonly sessionAtAdmission: SessionRecord | null | undefined;
  readonly history: CharacterHistoryReader;
  readonly privacy: PrivateDelegationProjection;
  readonly scopeId: string;
  readonly limits: NormalizedOrchestrationSettings;
  private calls: number;
  private readonly actors: Set<string>;
  constructor(args: {
    sessionId: string;
    store?: DataStore;
    settings?: unknown;
    sessionAtAdmission?: SessionRecord | null;
    saved?: DelegationSnapshot;
  }) {
    if (args.saved) delegationSnapshotSchema.parse(args.saved);
    this.sessionAtAdmission = args.sessionAtAdmission;
    this.privacy = new PrivateDelegationProjection(
      args.saved?.privateCallIds,
      args.saved?.concealedCallIds,
    );
    this.scopeId = args.saved?.scopeId ?? crypto.randomUUID();
    this.limits = Object.freeze(
      normalizeOrchestrationSettings(args.saved?.limits ?? args.settings),
    );
    this.calls = args.saved?.calls ?? 0;
    this.actors = new Set(args.saved?.actorIds);
    this.history = new CharacterHistoryReader(
      args.store,
      args.sessionId,
      args.saved?.historySnapshot,
    );
  }
  remaining() {
    return {
      maxActors: Math.max(0, this.limits.maxActors - this.actors.size),
      maxSubagentCalls: Math.max(0, this.limits.maxSubagentCalls - this.calls),
    };
  }
  claim(characterId?: string): "calls" | "actors" | undefined {
    if (this.calls >= this.limits.maxSubagentCalls) return "calls";
    if (
      characterId !== undefined &&
      !this.actors.has(characterId) &&
      this.actors.size >= this.limits.maxActors
    )
      return "actors";
    this.calls++;
    if (characterId !== undefined) this.actors.add(characterId);
    return undefined;
  }
  clamp(plan: TurnPolicyOutput, limits = this.remaining()): TurnPolicyOutput {
    const seen = new Set(this.actors);
    let calls = Math.min(
      limits.maxSubagentCalls,
      this.remaining().maxSubagentCalls,
    );
    let actors = Math.min(limits.maxActors, this.remaining().maxActors);
    return {
      ...plan,
      actors: plan.actors.filter((actor) => {
        if (calls <= 0) return false;
        if (!seen.has(actor.characterId)) {
          if (actors <= 0) return false;
          actors--;
          seen.add(actor.characterId);
        }
        calls--;
        return true;
      }),
    };
  }
  snapshot(): DelegationSnapshot {
    return {
      scopeId: this.scopeId,
      privateCallIds: [...this.privacy.calls],
      concealedCallIds: [...this.privacy.concealedCalls],
      limits: structuredClone(this.limits),
      calls: this.calls,
      actorIds: [...this.actors],
      ...(this.history.snapshot()
        ? { historySnapshot: this.history.snapshot() }
        : {}),
    };
  }
}

export async function createDelegationBudget(
  sessionId: string,
  store?: DataStore,
  saved?: DelegationSnapshot,
): Promise<DelegationBudget> {
  const session =
    !saved && store ? await store.getSession(sessionId) : undefined;
  return new DelegationBudget({
    sessionId,
    store,
    saved,
    settings: session?.metadata?.orchestration,
    sessionAtAdmission: session,
  });
}
