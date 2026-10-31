import { describe, expect, it, vi } from "vitest";
import type { Proposal, ProposalPayloadMap, ProposalType } from "@covel/shared";
import { withPendingProposals } from "@covel/plugin-handlers-utils";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  setup,
  presenter,
  timestamp,
  input,
  narrator,
} from "./presentation-fixture.js";
import { executeTurn } from "../src/execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  takePresentationSnapshot,
  emptyPresentationDigest,
} from "../src/presentation/projection.js";

function command<K extends ProposalType>(
  type: K,
  payload: ProposalPayloadMap[K],
): Proposal {
  return {
    id: crypto.randomUUID(),
    sessionId: "session",
    turnId: "source",
    source: { pluginId: "display", runtimeId: "display/cues" },
    type,
    payload,
    timestamp,
  } as Proposal;
}
const good = () =>
  command("plugin.data", {
    namespace: "display",
    key: "current",
    value: { scene: "Library" },
  });
describe("presentation commit isolation", () => {
  it("refuses a forged suspension before saving any continuation", async () => {
    const f = await setup();
    const execution = await f.run(async (ctx) => {
      await ctx.pluginData!.set("display", "partial", true);
      return {
        outcome: "suspended",
        reason: "Need confirmation",
        resumeSchema: { type: "object" },
      };
    });
    expect((await f.commit(execution)).status).toBe("committed");
    expect(await f.store.listSuspensions("session")).toHaveLength(0);
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    await f.store.close();
  });
  it("retains the all-or-nothing rule for an execution without a story", async () => {
    const f = await setup();
    const ordinary = {
      ...presenter(),
      name: "display/ordinary",
      presentation: undefined,
    };
    const execution = await executeTurn(
      input,
      [ordinary, presenter()],
      f.deps({
        [ordinary.name]: async (ctx) => {
          await ctx.pluginData!.set("display", "independent", true);
          return { outcome: "success", value: {} };
        },
        "display/cues": async () =>
          withPendingProposals({ outcome: "success", value: {} }, [good()]),
      }),
    );
    expect((await f.commit(execution)).status).toBe("failed");
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    await f.store.close();
  });
  it.each(["memory", "sqlite"])(
    "commits valid owned display state through %s",
    async (backend) => {
      const f = await setup(
        backend === "sqlite" ? createSqliteStore(":memory:") : undefined,
      );
      const execution = await f.run(async () =>
        withPendingProposals({ outcome: "success", value: {} }, [good()]),
      );
      expect((await f.commit(execution)).status).toBe("committed");
      expect(
        (
          await f.store.getPluginData(
            "session",
            "display",
            "display",
            "current",
          )
        )?.value,
      ).toEqual({ scene: "Library" });
      const terminal = (await f.store.listTraceEvents("session")).filter(
        (event) => event.type === "presentation.completed",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.payload).toMatchObject({
        status: "updated",
        budget: { calls: { limit: 0, used: 0 } },
      });
      await f.store.close();
    },
  );
  it.each([
    command("plugin.data", { namespace: "other", key: "bad", value: true }),
    command("plugin.data", {
      namespace: "_hidden.display",
      key: "bad",
      value: true,
    }),
    command("plugin.data.batch", {
      items: [
        { namespace: "display", key: "mixed", value: true },
        { namespace: "other", key: "bad", value: true },
      ],
    }),
    command("plugin.data.update", {
      namespace: "other",
      key: "bad",
      ops: [{ op: "set", value: true }],
    }),
    command("plugin.data.delete", { namespace: "other", key: "bad" }),
    command("narrative.append", { content: "Forbidden story", kind: "story" }),
  ])(
    "discards the entire display unit on %j and preserves the story",
    async (forbidden) => {
      const f = await setup();
      const execution = await f.run(async (ctx) => {
        await ctx.pluginData!.set("display", "buffered", true);
        return withPendingProposals({ outcome: "success", value: {} }, [
          good(),
          forbidden,
        ]);
      });
      const outcome = await f.commit(execution);
      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes?.map((row) => row.runtimeId)).toContain(
        "display/cues",
      );
      expect(
        await f.store.listPluginData("session", "display", "display"),
      ).toHaveLength(0);
      expect(
        (await f.store.listMessages("session")).some((message) =>
          message.content.includes("library is open"),
        ),
      ).toBe(true);
      await f.store.close();
    },
  );
  it("does not dispatch forbidden events or retain writes from a failed handler", async () => {
    const f = await setup();
    const execution = await f.run(async (ctx) => {
      await ctx.pluginData!.set("display", "buffered", true);
      return {
        outcome: "success",
        value: {},
        effects: { events: [{ topic: "forbidden", data: {} }] },
      };
    });
    expect(
      execution.result.runtimeResults.find(
        (row) => row.runtimeId === "display/cues",
      )?.status,
    ).toBe("failed");
    expect((await f.commit(execution)).status).toBe("committed");
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    await f.store.close();
  });
  it("refuses event fan-out before the same valid subscriber can run", async () => {
    const f = await setup();
    const subscriber = {
      ...presenter(),
      name: "display/subscriber",
      presentation: undefined,
      stage: undefined,
      trigger: { type: "event" as const, topic: "display.changed" },
      inputs: undefined,
    };
    const write = vi.fn(async () =>
      withPendingProposals({ outcome: "success" as const, value: {} }, [
        {
          ...good(),
          source: { pluginId: "display", runtimeId: subscriber.name },
        },
      ]),
    );
    for (const restricted of [false, true]) {
      const manifest = presenter(restricted ? {} : { presentation: undefined });
      const execution = await executeTurn(
        { ...input, turnId: `event-${restricted}` },
        [narrator, manifest, subscriber],
        f.deps({
          [manifest.name]: async (ctx) => {
            await ctx.pluginData!.set("display", "partial", true);
            return {
              outcome: "success",
              value: {},
              effects: {
                events: [{ topic: "display.changed", data: { visible: true } }],
              },
            };
          },
          [subscriber.name]: write,
        }),
      );
      expect((await f.commit(execution)).status).toBe("committed");
      if (!restricted) {
        expect(write).toHaveBeenCalledOnce();
        expect(
          await f.store.getPluginData(
            "session",
            "display",
            "display",
            "current",
          ),
        ).not.toBeNull();
        for (const row of await f.store.listPluginData(
          "session",
          "display",
          "display",
        ))
          await f.store.deletePluginData(
            "session",
            "display",
            row.namespace,
            row.key,
          );
        write.mockClear();
      } else {
        expect(write).not.toHaveBeenCalled();
        expect(
          await f.store.listPluginData("session", "display", "display"),
        ).toHaveLength(0);
      }
    }
    await f.store.close();
  });
  it("checks hook replacements and discards a failed handler's buffered writes after recovery", async () => {
    const f = await setup();
    const hooks = createHookPipeline();
    hooks.register<{ proposal: Proposal }>({
      id: "rewrite",
      pluginId: "display",
      event: "PreStateCommit",
      handler: async (_ctx, { proposal }) =>
        proposal.source.pluginId === "display"
          ? {
              action: "continue",
              replace: {
                proposal: command("plugin.data", {
                  namespace: "forbidden",
                  key: "bad",
                  value: true,
                }),
              },
            }
          : { action: "continue" },
    });
    const execution = await f.run(
      async (ctx) => {
        await ctx.pluginData!.set("display", "current", { scene: "Library" });
        return { outcome: "success", value: {} };
      },
      presenter(),
      { hookPipeline: hooks },
    );
    expect((await f.commit(execution, { hookPipeline: hooks })).status).toBe(
      "committed",
    );
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    const recovery = createHookPipeline();
    recovery.register<{ result: import("@covel/shared").RuntimeResult }>({
      id: "recover",
      pluginId: "display",
      event: "PostRuntime",
      handler: async (_ctx, { result }) =>
        result.pluginId === "display"
          ? {
              action: "continue",
              replace: { result: { ...result, status: "success", output: {} } },
            }
          : { action: "continue" },
    });
    const failed = await f.run(
      async (ctx) => {
        await ctx.pluginData!.set("display", "partial", true);
        throw new Error("private-handler-error");
      },
      presenter(),
      { hookPipeline: recovery },
    );
    expect((await f.commit(failed, { hookPipeline: recovery })).status).toBe(
      "committed",
    );
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    expect(
      JSON.stringify(await f.store.listTraceEvents("session")),
    ).not.toContain("private-handler-error");
    await f.store.close();
  });
  it("rejects media refs assembled across separate operations at the mutation boundary", async () => {
    const f = await setup();
    const execution = await f.run(async () =>
      withPendingProposals({ outcome: "success", value: {} }, [
        good(),
        command("plugin.data.update", {
          namespace: "display",
          key: "current",
          ops: [
            { op: "merge", value: { id: "unreachable-media" } },
            { op: "merge", value: { mime: "image/png" } },
            { op: "merge", value: { size: 1 } },
          ],
        }),
      ]),
    );
    const outcome = await f.commit(execution);
    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes?.map((row) => row.runtimeId)).toContain(
      "display/cues",
    );
    expect(
      await f.store.listPluginData("session", "display", "display"),
    ).toHaveLength(0);
    await f.store.close();
  });
  it.each(["memory", "sqlite"])(
    "checks supersession at mutation time on %s",
    async (backend) => {
      const f = await setup(
        backend === "sqlite" ? createSqliteStore(":memory:") : undefined,
      );
      const manifest = presenter({ turnCompletion: { mode: "detached" } });
      const snapshot = {
        ...(await takePresentationSnapshot({
          store: f.store,
          manifest,
          sessionId: "session",
          sourceTurnId: "source",
          sourceExecutionId: "source-execution",
          story: { segments: [{ kind: "narration", text: "Public story" }] },
        })),
        committed: true,
      };
      const execution = await f.run(
        async () =>
          withPendingProposals({ outcome: "success", value: {} }, [good()]),
        manifest,
        {},
        {
          sessionId: "session",
          turnId: "worker",
          origin: "manual",
          playerMessage: "",
          manualTrigger: { runtimeId: manifest.name },
          detachedStage: {
            jobId: "job",
            runtimeId: manifest.name,
            sourceTurnId: "source",
            sourceExecutionId: "source-execution",
            sourceExecutionStartedAt: timestamp,
            sourceLogicalTurn: 1,
            upstreamResults: [],
            turnDigest: emptyPresentationDigest("source"),
            presentation: snapshot,
          },
        },
      );
      expect(
        execution.result.runtimeResults.find(
          (row) => row.runtimeId === manifest.name,
        )?.status,
      ).toBe("success");
      await f.seed("display", "current", { scene: "New override" });
      expect((await f.commit(execution)).status).toBe("committed");
      expect(
        (
          await f.store.getPluginData(
            "session",
            "display",
            "display",
            "current",
          )
        )?.value,
      ).toEqual({ scene: "New override" });
      expect(
        (await f.store.listTraceEvents("session")).find(
          (row) => row.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({ status: "no-op", reason: "superseded" });
      await f.store.close();
    },
  );
});
