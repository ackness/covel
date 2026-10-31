import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { SuspensionRecord } from "@covel/store";
import {
  CHARACTER_ACTOR_CONTRACT,
  type RuntimeManifest,
  type SubagentResult,
} from "@covel/shared";
import {
  executeTurn,
  resumeSuspendedRuntime,
  commitExecution,
  type ExecutionDeps,
} from "../src/index.js";
import { prose } from "./_helpers/agent-loop-fixture.js";

const input = {
  sessionId: "session",
  turnId: "turn",
  playerMessage: "Continue",
  origin: "player" as const,
  locale: "en-US",
};
const actor: RuntimeManifest = {
  pluginId: "sample",
  name: "sample/actor",
  description: "Actor",
  runtimeType: "agent",
  outputKind: "system",
  subagentOnly: true,
  trigger: { type: "manual" },
  outputContract: CHARACTER_ACTOR_CONTRACT,
};
const parent = (name: string): RuntimeManifest => ({
  pluginId: "sample",
  name: `sample/${name}`,
  description: "Asker",
  runtimeType: "function",
  stage: "narrative",
  outputKind: "system",
});

describe("delegation across suspended legs", () => {
  it.each([
    { failResume: false, passClaim: false },
    { failResume: true, passClaim: false },
    { failResume: false, passClaim: true },
    { failResume: true, passClaim: true },
  ])(
    "shares sibling admissions and retains consumed budget with claim arguments %j",
    async ({ failResume, passClaim }) => {
      const store = createMemoryStore();
      await store.createSession({
        id: input.sessionId,
        locale: "en-US",
        status: "active",
        phase: "playing",
        seats: [],
        activePlugins: ["sample"],
        setupRuntimes: {},
        completedPlayerTurns: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        metadata: { orchestration: { maxActors: 1, maxSubagentCalls: 3 } },
      });
      await store.upsertCharacter({
        id: "a",
        name: "Mara",
        type: "npc",
        sessionId: input.sessionId,
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      const story = (id: string, text: string) =>
        store.addMessage({
          id,
          sessionId: input.sessionId,
          role: "assistant",
          content: text,
          metadata: {
            kind: "story",
            presentCharacterIds: ["a"],
            segments: [{ kind: "narration", text }],
          },
          createdAt: id,
        });
      await story("2026-01-01", "Original witnessed scene");
      const parents = [parent("one"), parent("two")];
      const runtimes = [...parents, actor];
      let starts = 0;
      let mode: "initial" | "resume" | "finish" = "initial";
      const replies: SubagentResult[] = [];
      const deps = (): ExecutionDeps => ({
        store,
        llm: {
          generate: async ({ messages }) => {
            starts++;
            expect(JSON.stringify(messages)).toContain(
              "Original witnessed scene",
            );
            expect(JSON.stringify(messages)).not.toContain(
              "INTERVENING-SECRET",
            );
            return prose(
              JSON.stringify({
                segments: [{ kind: "action", text: "Listens." }],
              }),
            );
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Act",
          ...(manifest.runtimeType === "function"
            ? {
                handler: async (ctx) => {
                  const result = await ctx.agents!.run({
                    target: { contract: CHARACTER_ACTOR_CONTRACT },
                    characterId: "a",
                    brief: "Respond",
                  });
                  replies.push(result);
                  if (mode === "resume" && failResume)
                    throw new Error("Failed after admission");
                  return mode === "finish"
                    ? { outcome: "success" as const, value: {} }
                    : {
                        outcome: "suspended" as const,
                        reason: "Continue later",
                        resumeSchema: { type: "object" },
                      };
                },
              }
            : {}),
        }),
      });
      const first = await executeTurn(input, runtimes, deps());
      expect(
        (
          await commitExecution({
            store,
            execution: first,
            completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
          })
        ).status,
      ).toBe("committed");
      const siblings = (await store.listSuspensions(input.sessionId)).filter(
        (row) => !row.resolvedAt,
      );
      expect(siblings).toHaveLength(2);
      expect(starts).toBe(2);
      expect(
        siblings.map((row) => row.pendingContinuation.delegation?.calls),
      ).toEqual([2, 2]);
      expect(
        new Set(
          siblings.map((row) => row.pendingContinuation.delegation?.scopeId),
        ).size,
      ).toBe(1);
      await story("2026-01-02", "INTERVENING-SECRET");
      const firstSibling = siblings[0]!;
      const claim = await store.claimSuspension(firstSibling.id);
      expect(claim).not.toBeNull();
      mode = "resume";
      const claimed: SuspensionRecord = { ...firstSibling, resolvedAt: claim! };
      const resumed = await resumeSuspendedRuntime(
        passClaim ? claimed : firstSibling,
        {},
        parents.find((manifest) => manifest.name === claimed.runtimeId)!,
        deps(),
        { activeRuntimes: runtimes },
      );
      expect(starts).toBe(3);
      expect((await store.getSuspension(claimed.id))?.resolvedAt).toBe(claim);
      expect(
        (await store.getSuspension(siblings[1]!.id))?.pendingContinuation
          .delegation?.calls,
      ).toBe(3);
      if (failResume) {
        expect(resumed.result.status).toBe("failed");
        expect(await store.releaseSuspensionClaim(claimed.id, claim!)).toBe(
          true,
        );
      } else {
        expect(resumed.result.status).toBe("suspended");
        expect(
          (
            await commitExecution({
              store,
              execution: resumed,
              completion: {
                kind: "resume",
                turnId: input.turnId,
                suspensionId: claimed.id,
                pluginId: claimed.pluginId,
                runtimeId: claimed.runtimeId,
              },
            })
          ).status,
        ).toBe("committed");
      }
      mode = "finish";
      // Rebuild all execution dependencies as a restarted host would.
      for (const row of (await store.listSuspensions(input.sessionId)).filter(
        (row) => !row.resolvedAt,
      )) {
        const done = await resumeSuspendedRuntime(
          row,
          {},
          parents.find((manifest) => manifest.name === row.runtimeId)!,
          deps(),
          { activeRuntimes: runtimes },
        );
        expect(done.result.status).toBe("success");
        expect(replies.at(-1)).toMatchObject({
          ok: false,
          error: { code: "unavailable" },
        });
        await commitExecution({
          store,
          execution: done,
          completion: {
            kind: "resume",
            turnId: input.turnId,
            suspensionId: row.id,
            pluginId: row.pluginId,
            runtimeId: row.runtimeId,
          },
        });
      }
      expect(starts).toBe(3);
      // New submissions start a separate root, without permanent session counters.
      await executeTurn({ ...input, turnId: "next" }, [parents[0]!, actor], {
        ...deps(),
        llm: {
          generate: async () => {
            starts++;
            return prose(
              JSON.stringify({
                segments: [{ kind: "action", text: "Waits." }],
              }),
            );
          },
        },
      });
      expect(starts).toBe(4);
      await store.close();
    },
  );
  it.each(["before", "during", "during-idle"])(
    "refuses a genuinely replaced claim %s resume work",
    async (when) => {
      const store = createMemoryStore();
      const main = parent("claim-owner");
      const starts = vi.fn();
      let resuming = false;
      let held: SuspensionRecord | undefined;
      try {
        await store.createSession({
          id: input.sessionId,
          status: "active",
          phase: "playing",
          locale: "en-US",
          activePlugins: ["sample"],
          setupRuntimes: {},
          seats: [],
          completedPlayerTurns: 0,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        });
        await store.upsertCharacter({
          id: "a",
          name: "Mara",
          sessionId: input.sessionId,
          type: "npc",
          version: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        });
        const replaceClaim = async () => {
          const live = await store.getSuspension(held!.id);
          await store.saveSuspension({
            ...live!,
            resolvedAt: "claimed:replacement",
          });
        };
        const deps: ExecutionDeps = {
          store,
          llm: {
            generate: async () => {
              starts();
              return prose(
                JSON.stringify({
                  segments: [{ kind: "action", text: "Waits." }],
                }),
              );
            },
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "Act",
            ...(manifest === main
              ? {
                  handler: async (ctx) => {
                    if (!resuming)
                      return {
                        outcome: "suspended" as const,
                        reason: "Continue later",
                        resumeSchema: { type: "object" },
                      };
                    if (when !== "during-idle")
                      expect(
                        (
                          await ctx.agents!.run({
                            target: { contract: CHARACTER_ACTOR_CONTRACT },
                            characterId: "a",
                            brief: "Respond",
                          })
                        ).ok,
                      ).toBe(true);
                    await replaceClaim();
                    return { outcome: "success" as const, value: {} };
                  },
                }
              : {}),
          }),
        };
        const first = await executeTurn(input, [main, actor], deps);
        await commitExecution({
          store,
          execution: first,
          completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        });
        held = (await store.listSuspensions(input.sessionId))[0]!;
        const claim = (await store.claimSuspension(held.id))!;
        resuming = true;
        if (when === "before") await replaceClaim();
        await expect(
          resumeSuspendedRuntime(
            when === "before" ? { ...held, resolvedAt: claim } : held,
            {},
            main,
            deps,
            { activeRuntimes: [main, actor] },
          ),
        ).rejects.toThrow(/Suspension claim changed/);
        expect(starts).toHaveBeenCalledTimes(when === "during" ? 1 : 0);
        const live = await store.getSuspension(held.id);
        expect(live?.resolvedAt).toBe("claimed:replacement");
        expect(live?.pendingContinuation).toEqual(held.pendingContinuation);
      } finally {
        await store.close();
      }
    },
  );
});
