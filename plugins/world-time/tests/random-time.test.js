import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRandom, restartSessionRandom } from "@covel/runtime";
import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { tool } from "@covel/tools";
import createAdvance from "../tools/advance-world-time.js";

const definition = {
  kind: "phases",
  name: "Dream",
  cycleLabel: "Loop",
  phases: ["Dawn", "Dusk", "Night"],
  initial: { cycle: 0, phase: 0 },
  evolution: {
    mode: "random",
    defaultStep: 1,
    maxStep: 4,
    randomRange: { min: -4, max: 4 },
  },
};
function context(sessionId, turnId) {
  restartSessionRandom(sessionId);
  return {
    sessionId,
    turnId,
    pluginId: "world-time",
    runtimeId: "world-time/advance",
    random: createPluginRandom({
      sessionId,
      pluginId: "world-time",
      stream: "world-time/advance",
    }),
    inputSlots: {
      currentTime: { value: { definition, tick: 0, locale: "en" } },
      narrative: { value: "Time slips." },
    },
    store: { getPluginData: async () => null },
  };
}

afterEach(() => vi.unstubAllEnvs());
describe("random world time", () => {
  it("uses the seeded host stream even when session and turn IDs change", async () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "world-time-regression");
    const advance = createAdvance({ tool });
    const sample = async (ctx) => {
      const deltas = [];
      for (let i = 0; i < 12; i++) {
        const result = await advance.execute(
          { reason: "Time slips." },
          { ...ctx, turnId: `${ctx.turnId}-${i}` },
        );
        deltas.push(getToolContent(result).lastDelta);
      }
      return deltas;
    };
    const first = await sample(context("random-a", "turn-a"));
    expect(await sample(context("random-b", "turn-b"))).toEqual(first);
    expect(first.every((delta) => delta >= -4 && delta <= 4)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
  it("reuses a buffered same-turn result without another random draw", async () => {
    const ctx = {
      ...context("random-repeat", "turn"),
      random: { int: vi.fn(() => -4) },
    };
    const advance = createAdvance({ tool });
    const first = await advance.execute({ reason: "Time slips." }, ctx);
    const [proposal] = getPendingProposals(first);
    const second = await advance.execute(
      { reason: "Repeated." },
      {
        ...ctx,
        store: {
          getPluginData: async () => ({ value: proposal.payload.value }),
        },
      },
    );
    expect(ctx.random.int).toHaveBeenCalledExactlyOnceWith(-4, 5);
    expect(getToolContent(second).tick).toBe(-4);
    expect(getPendingProposals(second)).toEqual([]);
  });
});
