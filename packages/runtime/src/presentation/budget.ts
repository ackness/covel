import { z } from "zod";
import {
  PRESENTATION_BUDGET_NAMESPACE,
  PresentationBudgetExhausted,
  type PresentationBudget,
  type PresentationSnapshot,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import {
  presentationIncarnation,
  PresentationUnavailable,
} from "./projection.js";

export { PRESENTATION_BUDGET_NAMESPACE } from "@covel/shared";
const OWNER = "__kernel:presentation";
const counters = z.strictObject({
  calls: z.number().int().nonnegative(),
  generations: z.number().int().nonnegative(),
});
const ledgerSchema = z.strictObject({
  version: z.literal(1),
  limits: counters,
  used: counters,
});
type BudgetStore = Pick<
  DataStore,
  "getSession" | "getPluginData" | "compareAndSetPluginData"
>;

/** Reservations survive failure, job replacement and process restart. */
export function createPresentationBudget(options: {
  readonly store?: BudgetStore;
  readonly sessionId: string;
  readonly snapshot: PresentationSnapshot;
  readonly currentLimits: PresentationBudget;
  readonly assertLive: () => void;
}) {
  const { store, sessionId, snapshot, assertLive } = options;
  let limits = {
    calls: Math.min(snapshot.limits.calls, options.currentLimits.calls),
    generations: Math.min(
      snapshot.limits.generations,
      options.currentLimits.generations,
    ),
  };
  let used: PresentationBudget = { calls: 0, generations: 0 };
  const key = JSON.stringify([
    snapshot.incarnation,
    snapshot.sourceTurnId,
    snapshot.pluginId,
    snapshot.runtimeId,
  ]);
  const readLedger = async () => {
    try {
      return await store?.getPluginData(
        sessionId,
        OWNER,
        PRESENTATION_BUDGET_NAMESPACE,
        key,
      );
    } catch {
      throw new PresentationUnavailable();
    }
  };
  const refresh = async () => {
    if (!store || !snapshot.incarnation) return;
    const row = await readLedger();
    if (!row) return;
    const previous = ledgerSchema.safeParse(row.value);
    if (!previous.success) throw new PresentationUnavailable();
    limits = {
      calls: Math.min(limits.calls, previous.data.limits.calls),
      generations: Math.min(
        limits.generations,
        previous.data.limits.generations,
      ),
    };
    used = previous.data.used;
  };
  return {
    refresh,
    usage: () => ({
      calls: { limit: limits.calls, used: used.calls },
      generations: { limit: limits.generations, used: used.generations },
    }),
    async reserve(generations = 0): Promise<void> {
      assertLive();
      if (
        !Number.isSafeInteger(generations) ||
        generations < 0 ||
        generations > 4
      )
        throw new RangeError(
          "Presentation generation units must be an integer from 0 to 4",
        );
      if (limits.calls === 0 || generations > limits.generations)
        throw new PresentationBudgetExhausted();
      if (!store || !snapshot.incarnation) throw new PresentationUnavailable();
      if (
        (await presentationIncarnation(store, sessionId).catch(() => {
          throw new PresentationUnavailable();
        })) !== snapshot.incarnation
      )
        throw new PresentationUnavailable();
      for (let attempt = 0; attempt < 64; attempt++) {
        assertLive();
        const row = await readLedger();
        const previous = row ? ledgerSchema.safeParse(row.value) : undefined;
        if (previous && !previous.success) throw new PresentationUnavailable();
        if (previous?.success) {
          limits = {
            calls: Math.min(limits.calls, previous.data.limits.calls),
            generations: Math.min(
              limits.generations,
              previous.data.limits.generations,
            ),
          };
          used = previous.data.used;
        }
        if (
          used.calls + 1 > limits.calls ||
          used.generations + generations > limits.generations
        )
          throw new PresentationBudgetExhausted();
        const next = {
          calls: used.calls + 1,
          generations: used.generations + generations,
        };
        const now = new Date(
          Math.max(Date.now(), row ? Date.parse(row.updatedAt) + 1 : 0),
        ).toISOString();
        assertLive();
        if (
          await store
            .compareAndSetPluginData(
              {
                id: row?.id ?? crypto.randomUUID(),
                sessionId,
                pluginId: OWNER,
                namespace: PRESENTATION_BUDGET_NAMESPACE,
                key,
                value: { version: 1, limits, used: next },
                createdAt: row?.createdAt ?? now,
                updatedAt: now,
              },
              row?.updatedAt ?? null,
            )
            .catch(() => {
              throw new PresentationUnavailable();
            })
        ) {
          used = next;
          // A cancelled reservation is deliberately retained, never refunded.
          assertLive();
          return;
        }
      }
      throw new PresentationUnavailable();
    },
  };
}
