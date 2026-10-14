import * as runtime from "@covel/runtime";
import { runtimeManifestInputSchema } from "@covel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tool, z } from "@covel/tools";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import {
  createPluginTestStore,
  executeToolAndCommit,
  commitToolResults,
} from "../src/index.js";

const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "notes",
  runtimeId: "notes/write",
};
const result = (namespace: string, key = "current") =>
  withPendingProposals({ saved: true }, [
    makeProposal(context, new Date().toISOString(), "plugin.data", {
      namespace,
      key,
      value: "saved",
    }),
  ]);

describe("tool integration harness", () => {
  it("runs argument parsing, scoped reads and durable commit through the host", async () => {
    const store = await createPluginTestStore(context);
    const save = tool({
      name: "save",
      description: "Save note",
      parameters: z.object({ title: z.string().default("default") }),
      async execute(args, ctx) {
        expect(args.title).toBe("default");
        expect(await ctx.store!.getPluginData("notes", "current")).toBeNull();
        return result("notes");
      },
    });
    await executeToolAndCommit(save, {}, context, store);
    expect(
      (await store.getPluginData("session", "notes", "notes", "current"))
        ?.value,
    ).toBe("saved");
    await store.close();
  });

  it("rejects reserved writes and rolls back earlier writes in the same execution", async () => {
    const store = await createPluginTestStore(context);
    await expect(
      commitToolResults([result("notes"), result("_jobs")], context, store),
    ).rejects.toThrow(/reserved/i);
    expect(await store.listPluginData("session", "notes")).toEqual([]);
    await store.close();
  });

  it("does not report a failed tool as successfully committed", async () => {
    const store = await createPluginTestStore(context);
    const fail = tool({
      name: "fail",
      description: "Fail",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("test failure");
      },
    });
    await expect(
      executeToolAndCommit(fail, {}, context, store),
    ).rejects.toThrow("test failure");
    expect(await store.listPluginData("session", "notes")).toEqual([]);
    await store.close();
  });
});

afterEach(() => vi.restoreAllMocks());
it("executes a schema-valid manual function manifest", async () => {
  const executeTurn = runtime.executeTurn;
  const spy = vi
    .spyOn(runtime, "executeTurn")
    .mockImplementationOnce(async (...args) => {
      const manifest = args[1][0];
      expect(manifest).toBeDefined();
      const { pluginId, ...input } = manifest!;
      expect(pluginId).toBe(context.pluginId);
      expect(runtimeManifestInputSchema.safeParse(input).success).toBe(true);
      expect(manifest).toMatchObject({
        runtimeType: "function",
        trigger: { type: "manual" },
        handler: expect.any(String),
      });
      expect(manifest?.stage).toBeUndefined();
      return executeTurn(...args);
    });
  const store = await createPluginTestStore(context);
  try {
    await commitToolResults([result("notes")], context, store);
    expect(spy).toHaveBeenCalledOnce();
    expect(
      (await store.getPluginData("session", "notes", "notes", "current"))
        ?.value,
    ).toBe("saved");
  } finally {
    await store.close();
  }
});
