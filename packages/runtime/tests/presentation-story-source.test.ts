import { describe, expect, it, vi } from "vitest";
import type { DeferredRuntimeJob, RuntimeManifest } from "@covel/shared";
import { createSqliteStore } from "@covel/store/sqlite";
import { executeTurn } from "../src/execution.js";
import {
  capturePresentationRecovery,
  finalizePresentationJobs,
} from "../src/presentation/jobs.js";
import {
  applySuspensionAbandonTx,
  planSuspensionAbandon,
} from "../src/resume/suspension-settlement.js";
import { input, presenter, setup, story } from "./presentation-fixture.js";

const director: RuntimeManifest = {
  name: "director",
  pluginId: "director",
  description: "Calls a story",
  runtimeType: "function",
  stage: "narrative",
  outputKind: "system",
};
const child: RuntimeManifest = {
  name: "director/aside",
  pluginId: "director",
  description: "Nested public story",
  runtimeType: "function",
  outputKind: "story",
  trigger: { type: "manual" },
};
const waiting: RuntimeManifest = {
  name: "display/wait",
  pluginId: "display",
  description: "Suspends the source execution",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
};

describe("durable story call identity", () => {
  it.each(["deferred", "recovery"])(
    "distinguishes nested and top-level calls of the same runtime for %s",
    async (mode) => {
      const f = await setup();
      const display = presenter(
        mode === "deferred" ? { turnCompletion: { mode: "detached" } } : {},
      );
      const eventStory: RuntimeManifest = {
        ...child,
        trigger: { type: "event", topic: "story.aside" },
      };
      const runtimes = [director, eventStory, display];
      const nested = {
        segments: [
          { kind: "narration", text: "A private aside for the caller." },
        ],
      };
      let calls = 0;
      try {
        const execution = await executeTurn(
          input,
          runtimes,
          f.deps({
            [director.name]: async (ctx) => {
              await ctx.recursiveCall!({
                manualTrigger: { runtimeId: child.name },
              });
              return {
                outcome: "success",
                value: {},
                effects: { events: [{ topic: "story.aside", data: {} }] },
              };
            },
            [child.name]: async () => ({
              outcome: "success",
              value: ++calls === 1 ? nested : story,
            }),
            [display.name]: async () => {
              throw new Error("Retry selector");
            },
          }),
        );
        let jobs: readonly DeferredRuntimeJob[] = [];
        const outcome = await f.commit(execution, {
          extraInTx: async (tx) => {
            jobs = await finalizePresentationJobs(
              tx,
              "session",
              execution.result.deferredRuntimeJobs ?? [],
              runtimes,
              true,
            );
          },
        });
        expect(calls).toBe(2);
        expect(outcome.status).toBe("committed");
        expect(outcome.turnStoryMessageIds).toHaveLength(1);
        const messages = (await f.store.listMessages("session")).filter(
          (message) =>
            (message.metadata as { kind?: string })?.kind === "story",
        );
        expect(messages).toHaveLength(2);
        expect(
          messages.map(
            (message) =>
              (message.metadata as { storySource?: unknown }).storySource,
          ),
        ).toEqual([
          expect.objectContaining({
            pluginId: child.pluginId,
            runtimeId: child.name,
            scope: "nested",
          }),
          expect.objectContaining({
            pluginId: child.pluginId,
            runtimeId: child.name,
            scope: "top-level",
          }),
        ]);
        if (mode === "deferred") {
          expect(jobs).toHaveLength(1);
          expect(jobs[0]?.presentation?.story).toEqual(story);
        } else {
          const source = execution.result.runtimeResults.find(
            (result) => result.runtimeId === display.name,
          );
          expect(source?.status).toBe("failed");
          expect(
            (
              await capturePresentationRecovery(
                f.store,
                "session",
                display,
                source!,
                runtimes,
              )
            )?.story,
          ).toEqual(story);
        }
      } finally {
        await f.store.close();
      }
    },
  );
  it.each(["memory", "sqlite"])(
    "does not release paid presentation for a nested story on %s",
    async (backend) => {
      const f = await setup(
        backend === "sqlite" ? createSqliteStore(":memory:") : undefined,
      );
      const display = presenter({
        version: "1.0.0",
        presentation: {
          budget: { calls: 1 },
          publicAssetNamespaces: ["assets"],
        },
        turnCompletion: { mode: "detached" },
      });
      const runtimes = [director, child, waiting, display];
      const paid = vi.fn(async () => ({
        outcome: "success" as const,
        value: {},
      }));
      try {
        const execution = await executeTurn(
          input,
          runtimes,
          f.deps({
            [director.name]: async (ctx) => {
              await ctx.recursiveCall!({
                manualTrigger: { runtimeId: child.name },
              });
              return { outcome: "success", value: {} };
            },
            [child.name]: async () => ({ outcome: "success", value: story }),
            [waiting.name]: async () => ({
              outcome: "suspended",
              reason: "Wait",
              resumeSchema: { type: "string" },
            }),
            [display.name]: paid,
          }),
        );
        expect(execution.result.withheldRuntimeJobs).toHaveLength(1);
        const outcome = await f.commit(execution);
        expect(outcome.status).toBe("committed");
        expect(outcome.turnStoryMessageIds).toEqual([]);
        const [suspension] = await f.store.listSuspensions("session");
        expect(suspension).toBeDefined();
        const saved = suspension!.pendingContinuation
          .withheldRuntimeJobs as readonly DeferredRuntimeJob[];
        expect(saved).toHaveLength(1);
        expect(saved[0]?.presentation?.committed).toBe(false);
        expect(saved[0]?.presentation?.story).toBeUndefined();
        const plan = await planSuspensionAbandon(f.store, suspension!);
        const released = await f.store.withTransaction(async (tx) => {
          await applySuspensionAbandonTx(tx, plan, new Date().toISOString());
          // The release has only saved records, with no live nested-message list.
          return finalizePresentationJobs(
            tx,
            "session",
            plan.releasedRuntimeJobs,
            runtimes,
            true,
          );
        });
        expect(released).toEqual([]);
        expect(paid).not.toHaveBeenCalled();
        expect(await f.store.listSuspensions("session")).toEqual([]);
        expect(
          (await f.store.listTraceEvents("session")).find(
            (event) => event.type === "presentation.completed",
          )?.payload,
        ).toMatchObject({ status: "no-op", reason: "no-story" });
      } finally {
        await f.store.close();
      }
    },
  );
});
