import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  exportSessionCheckpoint,
  validateBrowserCheckpoint,
} from "@covel/store";
import { createEventBus } from "@covel/events";
import type { RuntimeManifest } from "@covel/shared";
import type {
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";

const timestamp = "2026-09-29T00:00:00.000Z";
const outputSchema = {
  type: "object",
  properties: { threshold: { type: "number" } },
  required: ["threshold"],
};

describe("function suspension transaction", () => {
  it.each(["success", "handler-failure", "commit-failure"] as const)(
    "restores frozen context and pending writes through public resume (%s)",
    async (termination) => {
      const store = createMemoryStore();
      await store.createSession({
        id: "s",
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        activePlugins: ["probe"],
        completedPlayerTurns: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const producer: RuntimeManifest = {
        description: "test",
        name: "probe/producer",
        pluginId: "probe",
        runtimeType: "function",
        stage: "pre-turn",
        trigger: { type: "auto" },
        output: { recordAs: "config", schema: "./output.json" },
      };
      const consumer: RuntimeManifest = {
        description: "test",
        name: "probe/consumer",
        pluginId: "probe",
        runtimeType: "function",
        stage: "narrative",
        trigger: { type: "auto" },
        inputs: {
          config: { from: { runtime: producer.name }, required: true },
        },
        input: {
          inject: [
            {
              kind: "runtime-export",
              name: "savedConfig",
              from: { runtime: producer.name },
              recordAs: "config",
              required: true,
            },
          ],
        },
      };
      const seed = {
        sessionId: "s",
        producerPluginId: "probe",
        producerRuntimeId: producer.name,
        recordAs: "config",
        revision: 1,
        pluginVersion: "0.0.0",
        schemaDigest: "seed",
        resultId: "old-result",
        value: { threshold: 7 },
        committedAt: timestamp,
      };
      await store.appendRuntimeExport(seed);
      let originalContext:
        | Pick<FunctionHandlerContext, "inputs" | "exports" | "activation">
        | undefined;
      let resumedContext: typeof originalContext;
      let resumedRead: unknown;
      let originalFrozen: boolean[] = [];
      let resumedFrozen: boolean[] = [];
      const handler = vi.fn(async (ctx: FunctionHandlerContext) => {
        if (!ctx.resumedFromSuspensionId) {
          originalContext = structuredClone({
            inputs: ctx.inputs,
            exports: ctx.exports,
            activation: ctx.activation,
          });
          originalFrozen = [
            Object.isFrozen(ctx.inputs?.config),
            Object.isFrozen(ctx.exports?.savedConfig),
            Object.isFrozen(ctx.activation),
          ];
          await ctx.pluginData!.set("notes", "counter", { count: 1 });
          await ctx.pluginData!.set("notes", "initial", true);
          return { outcome: "suspended" as const, reason: "Need confirmation" };
        }
        resumedContext = structuredClone({
          inputs: ctx.inputs,
          exports: ctx.exports,
          activation: ctx.activation,
        });
        resumedFrozen = [
          Object.isFrozen(ctx.inputs?.config),
          Object.isFrozen(ctx.exports?.savedConfig),
          Object.isFrozen(ctx.activation),
        ];
        resumedRead = await ctx.pluginData!.get("notes", "counter");
        await ctx.pluginData!.set("notes", "counter", { count: 2 });
        await ctx.pluginData!.set("notes", "resumed", true);
        return termination === "handler-failure"
          ? { outcome: "failed" as const, error: "Rejected confirmation" }
          : { outcome: "success" as const, value: { confirmed: true } };
      });
      const deps = {
        store,
        llm: { generate: vi.fn() },
        loadRuntime: async (
          runtime: RuntimeManifest,
        ): Promise<LoadedRuntime> => ({
          manifest: runtime,
          promptTemplate: "",
          ...(runtime.name === producer.name ? { outputSchema } : {}),
          handler:
            runtime.name === consumer.name
              ? handler
              : async () => ({ outcome: "success", value: { threshold: 10 } }),
        }),
      };
      const execution = await executeTurn(
        {
          sessionId: "s",
          turnId: "t",
          logicalTurnId: "logical-t",
          playerMessage: "Continue",
          origin: "player",
        },
        [producer, consumer],
        deps,
      );
      expect(
        execution.result.runtimeResults.map((result) => result.status),
      ).toEqual(["success", "suspended"]);
      expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
      expect(
        (
          await commitExecution({
            store,
            execution,
            completion: { kind: "turn", turnId: "t", durationMs: 0 },
          })
        ).status,
      ).toBe("committed");
      const suspension = (await store.listSuspensions("s"))[0]!;
      expect(suspension.pendingContinuation.pendingProposals).toHaveLength(2);
      expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
      expect((await store.getSession("s"))?.completedPlayerTurns).toBe(0);

      const checkpoint = await exportSessionCheckpoint(store, "s", {
        revision: 1,
        actionId: "roundtrip",
      });
      const restored = validateBrowserCheckpoint(
        JSON.parse(JSON.stringify(checkpoint)),
      ).suspensions[0]!;
      expect(restored.pendingContinuation).toEqual(
        suspension.pendingContinuation,
      );
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          suspensions: [
            {
              ...suspension,
              pendingContinuation: {
                ...suspension.pendingContinuation,
                activation: {
                  source: "unknown",
                  detached: false,
                  payload: null,
                },
              },
            },
          ],
        }),
      ).toThrow(/activation.source/);

      await store.appendRuntimeExport({
        ...seed,
        revision: 3,
        value: { threshold: 99 },
      });
      const resumed = await resumeSuspendedRuntime(
        restored,
        { confirmed: true },
        consumer,
        deps,
      );
      expect(handler).toHaveBeenCalledTimes(2);
      expect(resumedContext).toEqual(originalContext);
      expect(originalFrozen).toEqual([true, true, true]);
      expect(resumedFrozen).toEqual([true, true, true]);
      expect(resumedRead).toEqual({ count: 1 });
      expect(resumed.result.status).toBe(
        termination === "handler-failure" ? "failed" : "success",
      );
      expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
      const snapshotsBefore = (await store.listSnapshots("s")).length;
      const eventBus = createEventBus();
      const events: string[] = [];
      eventBus.onEmit((event) => events.push(event.type));
      const extraInTx = vi.fn(async () => {
        if (termination === "commit-failure")
          throw new Error("commit rejected");
      });
      const outcome = await commitExecution({
        store,
        eventBus,
        execution: resumed,
        extraInTx,
        completion: {
          kind: "resume",
          turnId: "t",
          suspensionId: suspension.id,
          pluginId: consumer.pluginId,
          runtimeId: consumer.name,
        },
      });
      if (termination === "success") {
        expect(outcome.status).toBe("committed");
        expect(
          (await store.getPluginData("s", "probe", "notes", "counter"))?.value,
        ).toEqual({ count: 2 });
        expect(
          (await store.getPluginData("s", "probe", "notes", "resumed"))?.value,
        ).toBe(true);
        expect(
          (await store.getPluginData("s", "probe", "notes", "initial"))?.value,
        ).toBe(true);
        expect(
          (await store.getSuspension(suspension.id))?.resolvedAt,
        ).toBeDefined();
        expect((await store.getSession("s"))?.completedPlayerTurns).toBe(1);
        expect(events).toContain("turn.resumed");
      } else {
        expect(outcome.status).toBe("failed");
        expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
        expect(
          (await store.getSuspension(suspension.id))?.resolvedAt,
        ).toBeUndefined();
        expect((await store.getSession("s"))?.completedPlayerTurns).toBe(0);
        expect(await store.listSnapshots("s")).toHaveLength(snapshotsBefore);
        expect(events).not.toContain("turn.resumed");
        if (termination === "handler-failure")
          expect(extraInTx).not.toHaveBeenCalled();
      }
    },
  );
});
