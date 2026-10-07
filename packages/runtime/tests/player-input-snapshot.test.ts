import {
  loadLastPlayerInput,
  loadTurnSessionState,
} from "../src/turn-executor/session-state.js";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { turnDigestSchema, type RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import {
  buildTurnDigest,
  snapshotPlayerInput,
} from "../src/turn-executor/turn-digest.js";

const form = {
  id: "a",
  sessionId: "session",
  turnId: "previous",
  formId: "profile",
  values: { nested: { name: "Alice" } },
  createdAt: "2026-09-28T00:00:00Z",
};

describe("source player input snapshot", () => {
  it("owns and freezes nested values and rejects the old digest shape", () => {
    const source = structuredClone(form);
    const snapshot = snapshotPlayerInput(source)!;
    source.values.nested.name = "Changed";
    expect(snapshot.values.nested).toEqual({ name: "Alice" });
    expect(Object.isFrozen(snapshot.values.nested)).toBe(true);
    const digest = buildTurnDigest(
      {
        sessionId: "session",
        turnId: "now",
        playerMessage: "Go",
        origin: "player",
      },
      [],
      [],
      snapshot,
    );
    expect(digest.lastPlayerInput?.turnId).toBe("previous");
    expect(digest.runtimeResults).toEqual([]);
    const { lastPlayerInput: _form, runtimeResults: _results, ...old } = digest;
    expect(turnDigestSchema.safeParse(old).success).toBe(false);
    expect(
      turnDigestSchema.safeParse({ ...digest, lastPlayerInput: "Go" }).success,
    ).toBe(false);
  });

  it.each([true, false])(
    "supplies the same source snapshot to function and guard (hasForm=%s)",
    async (hasForm) => {
      const store = createMemoryStore();
      await store.createSession({
        id: "session",
        worldId: null,
        status: "active",
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: ["function", "guard"],
        createdAt: form.createdAt,
        updatedAt: form.createdAt,
      });
      if (hasForm) await store.savePlayerInput(form);
      const manifest = (
        name: string,
        runtimeType: "function" | "agent",
      ): RuntimeManifest => ({
        name,
        pluginId: name,
        description: name,
        runtimeType,
        handler: "./handler.js",
        stage: "narrative",
        outputKind: "system",
        trigger: { type: "auto" },
      });
      const seen: unknown[] = [];
      const generate = vi.fn(async () => {
        throw new Error("Guard must skip model execution");
      });
      const result = await executeTurn(
        {
          sessionId: "session",
          turnId: "now",
          playerMessage: "Current command",
          origin: "player",
        },
        [manifest("function", "function"), manifest("guard", "agent")],
        {
          store,
          llm: { generate },
          loadRuntime: async (runtime) => ({
            manifest: runtime,
            promptTemplate: "",
            ...(runtime.runtimeType === "function"
              ? {
                  handler: async (ctx) => {
                    seen.push(ctx.session?.lastPlayerInput);
                    expect(ctx.playerMessage).toBe("Current command");
                    return { outcome: "success", value: {} };
                  },
                }
              : {
                  guard: async (ctx) => {
                    seen.push(ctx.session?.lastPlayerInput);
                    return { skip: true };
                  },
                }),
          }),
        },
      );
      expect(result.runtimeResults.map((r) => r.status).sort()).toEqual([
        "skipped",
        "success",
      ]);
      expect(seen).toEqual([hasForm ? form : null, hasForm ? form : null]);
      if (hasForm) expect(seen[0]).not.toBe(seen[1]);
      expect(generate).not.toHaveBeenCalled();
      await store.close();
    },
  );
});

it("selects the newest persisted submission independently of store enumeration order", async () => {
  const store = createMemoryStore();
  const later = { ...form, id: "z", createdAt: "2026-09-28T00:00:01.000Z" };
  for (const input of [later, { ...later, id: "b" }, form])
    await store.savePlayerInput(input);
  const list = vi
    .spyOn(store, "listPlayerInputs")
    .mockRejectedValue(new Error("Full input log must not be loaded"));
  expect(await loadLastPlayerInput(store, "session")).toEqual(later);
  expect(list).not.toHaveBeenCalled();
  await store.close();
});

it.each(["foreign-session", "foreign-turn"])(
  "rejects a detached %s source before runtime execution",
  async (mismatch) => {
    const loadRuntime = vi.fn();
    const generate = vi.fn();
    const digest = buildTurnDigest(
      {
        sessionId: "session",
        turnId: "source",
        playerMessage: "Go",
        origin: "player",
      },
      [],
      [],
      form,
    );
    const turnDigest =
      mismatch === "foreign-session"
        ? {
            ...digest,
            lastPlayerInput: { ...form, sessionId: "another-session" },
          }
        : { ...digest, turnId: "another-turn" };
    await expect(
      loadTurnSessionState({
        input: {
          sessionId: "session",
          turnId: "worker",
          playerMessage: "",
          origin: "background",
          detachedStage: {
            jobId: "job",
            runtimeId: "memory/extract",
            sourceTurnId: "source",
            sourceExecutionId: "execution",
            sourceExecutionStartedAt: form.createdAt,
            upstreamResults: [],
            turnDigest,
          },
        },
        deps: { loadRuntime, llm: { generate } },
        shouldAppendPlayerMessage: false,
      }),
    ).rejects.toThrow("does not belong to this execution");
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  },
);
