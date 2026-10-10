import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import { executeTurn } from "../src/execution.js";

afterEach(() => vi.restoreAllMocks());

function subscriber(
  id: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `events/${id}`,
    pluginId: "events",
    description: id,
    runtimeType: "function",
    handler: "./handler.js",
    outputKind: "system",
    trigger: { type: "event", topic: "flow.changed" },
    ...overrides,
  } as RuntimeManifest;
}

async function run(
  subscribers: RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  guards: Record<string, LoadedRuntime["guard"]> = {},
) {
  const emitter = subscriber("emitter", {
    stage: "pre-turn",
    trigger: { type: "auto" },
  });
  const store = createMemoryStore();
  const timestamp = "2026-10-05T00:00:00Z";
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: ["events"],
    setupRuntimes: {},
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const execution = await executeTurn(
    {
      origin: "player",
      sessionId: "session",
      turnId: "turn",
      playerMessage: "go",
    },
    [emitter, ...subscribers],
    {
      store,
      llm: {
        generate: async () => {
          throw new Error("No model expected");
        },
      },
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        guard: guards[manifest.name],
        handler:
          manifest.name === emitter.name
            ? async () => ({
                outcome: "success",
                value: {},
                effects: {
                  events: [{ topic: "flow.changed", data: { seed: 1 } }],
                },
              })
            : handlers[manifest.name],
      }),
    },
  );
  return execution.result.runtimeResults;
}

const provider = subscriber("z-provider");
const consumer = subscriber("a-consumer", {
  needs: [{ runtime: provider.name }],
  inputs: {
    number: {
      from: { runtime: provider.name },
      select: "/number",
      required: true,
    },
  },
});

describe("same-depth synchronous event dependencies", () => {
  it.each(["success", "skipped"] as const)(
    "uses a prior-depth %s provider to satisfy an OR need without creating a cycle",
    async (outcome) => {
      const prior = subscriber("prior", {
        outputContract: "seed@1",
        ...(outcome === "skipped"
          ? { runtimeType: "agent", guard: "./guard.js" }
          : {}),
      });
      const advance = subscriber("advance");
      const next = subscriber("next", {
        trigger: { type: "event", topic: "second" },
        needs: [{ capability: "seed@1", cardinality: "one" }],
      });
      const alternative = subscriber("alternative", {
        trigger: { type: "event", topic: "second" },
        outputContract: "seed@1",
        needs: [{ runtime: next.name }],
      });
      const results = await run(
        [prior, advance, next, alternative],
        {
          [prior.name]: async () => ({
            outcome: "success",
            value: { number: 42 },
          }),
          [advance.name]: async () => ({
            outcome: "success",
            value: {},
            effects: { events: [{ topic: "second", data: {} }] },
          }),
          [next.name]: async () => ({ outcome: "success", value: {} }),
          [alternative.name]: async () => ({ outcome: "success", value: {} }),
        },
        outcome === "skipped"
          ? { [prior.name]: async () => ({ skip: true, initialized: true }) }
          : {},
      );
      expect(
        results.find((result) => result.runtimeId === prior.name)?.status,
      ).toBe(outcome);
      expect(
        results.find((result) => result.runtimeId === next.name)?.status,
      ).toBe("success");
      expect(
        results.find((result) => result.runtimeId === alternative.name)?.status,
      ).toBe("success");
    },
  );

  it.each(["all", "after", "binding", "runtime"] as const)(
    "does not relax a %s hard edge when an external OR provider has succeeded",
    async (edge) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const prior = subscriber("prior", { outputContract: "seed@1" });
      const next = subscriber("next", {
        trigger: { type: "event", topic: "second" },
        needs: [{ capability: "seed@1", cardinality: "one" }],
        ...(edge === "all"
          ? { needs: [{ capability: "seed@1", cardinality: "all" }] }
          : edge === "after"
            ? { after: [{ capability: "seed@1" }] }
            : edge === "binding"
              ? {
                  inputs: {
                    seed: { from: { capability: "seed@1" }, required: true },
                  },
                }
              : { needs: [{ runtime: "events/alternative" }] }),
      });
      const alternative = subscriber("alternative", {
        trigger: { type: "event", topic: "second" },
        outputContract: "seed@1",
        needs: [{ runtime: next.name }],
      });
      const handler = vi.fn(async () => ({
        outcome: "success" as const,
        value: {},
      }));
      const results = await run([prior, next, alternative], {
        [prior.name]: async () => ({
          outcome: "success",
          value: { number: 42 },
          effects: { events: [{ topic: "second", data: {} }] },
        }),
        [next.name]: handler,
        [alternative.name]: handler,
      });
      expect(handler).not.toHaveBeenCalled();
      expect(
        results.find((result) => result.runtimeId === next.name),
      ).toMatchObject({
        status: "skipped",
        output: { reason: "dependency-cycle" },
      });
    },
  );

  it("does not use a failed prior-depth provider as evidence for an OR need", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const prior = subscriber("prior", { outputContract: "seed@1" });
    const advance = subscriber("advance");
    const next = subscriber("next", {
      trigger: { type: "event", topic: "second" },
      needs: [{ capability: "seed@1", cardinality: "one" }],
    });
    const alternative = subscriber("alternative", {
      trigger: { type: "event", topic: "second" },
      outputContract: "seed@1",
      needs: [{ runtime: next.name }],
    });
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const results = await run([prior, advance, next, alternative], {
      [prior.name]: async () => {
        throw new Error("Provider failed");
      },
      [advance.name]: async () => ({
        outcome: "success",
        value: {},
        effects: { events: [{ topic: "second", data: {} }] },
      }),
      [next.name]: handler,
      [alternative.name]: handler,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(
      results.find((result) => result.runtimeId === next.name),
    ).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-cycle" },
    });
  });

  it("binds a successful provider before executing its dependent subscriber", async () => {
    const results = await run([consumer, provider], {
      [provider.name]: async () => ({
        outcome: "success",
        value: { number: 42 },
      }),
      [consumer.name]: async (ctx) => ({
        outcome: "success",
        value: {
          observed: ctx.inputs?.number?.value,
          event: ctx.triggerEvent?.data,
        },
      }),
    });
    expect(
      results.find((result) => result.runtimeId === consumer.name),
    ).toMatchObject({
      status: "success",
      output: { observed: 42, event: { seed: 1 } },
    });
    expect(results.map((result) => result.runtimeId)).toEqual([
      "events/emitter",
      provider.name,
      consumer.name,
    ]);
  });

  it("skips a hard dependent after an upstream failure without running its handler", async () => {
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const results = await run([consumer, provider], {
      [provider.name]: async () => {
        throw new Error("Provider failed");
      },
      [consumer.name]: handler,
    });
    expect(
      results.find((result) => result.runtimeId === provider.name)?.status,
    ).toBe("failed");
    expect(
      results.find((result) => result.runtimeId === consumer.name),
    ).toMatchObject({ status: "skipped" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("honors after-only ordering even when the predecessor fails", async () => {
    const ordered = subscriber("a-after", {
      after: [{ runtime: provider.name }],
    });
    const calls: string[] = [];
    const results = await run([ordered, provider], {
      [provider.name]: async () => {
        calls.push("provider");
        throw new Error("Provider failed");
      },
      [ordered.name]: async () => {
        calls.push("after");
        return { outcome: "success", value: {} };
      },
    });
    expect(calls).toEqual(["provider", "after"]);
    expect(
      results.find((result) => result.runtimeId === ordered.name)?.status,
    ).toBe("success");
  });

  it("does not activate an unmatched event provider to satisfy needs", async () => {
    const unmatched = subscriber("z-provider", {
      trigger: { type: "event", topic: "other.topic" },
    });
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const results = await run([consumer, unmatched], {
      [provider.name]: handler,
      [consumer.name]: handler,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(
      results.find((result) => result.runtimeId === consumer.name)?.status,
    ).toBe("skipped");
    expect(results.some((result) => result.runtimeId === provider.name)).toBe(
      false,
    );
  });

  it("isolates cycles and their blocked dependents while running independent subscribers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = subscriber("cycle-a", { after: ["events/cycle-b"] });
    const b = subscriber("cycle-b", { after: [a.name] });
    const blocked = subscriber("blocked", { needs: [a.name] });
    const independent = subscriber("independent");
    const cycleHandler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const results = await run([blocked, a, b, independent], {
      [a.name]: cycleHandler,
      [b.name]: cycleHandler,
      [blocked.name]: cycleHandler,
      [independent.name]: async () => ({ outcome: "success", value: {} }),
    });
    expect(cycleHandler).not.toHaveBeenCalled();
    for (const runtime of [a, b, blocked]) {
      expect(
        results.find((result) => result.runtimeId === runtime.name),
      ).toMatchObject({
        status: "skipped",
        output: { reason: "dependency-cycle" },
      });
    }
    expect(
      results.find((result) => result.runtimeId === independent.name)?.status,
    ).toBe("success");
  });

  it("keeps independent subscribers parallel within a DAG level", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const a = subscriber("independent-a");
    const b = subscriber("independent-b");
    const handler: FunctionHandler = async (ctx) => {
      started.push(ctx.runtimeId);
      await barrier;
      return { outcome: "success", value: {} };
    };
    const pending = run([a, b], { [a.name]: handler, [b.name]: handler });
    try {
      await vi.waitFor(() => expect(started).toHaveLength(2));
    } finally {
      release();
    }
    expect(
      (await pending).filter((result) => result.status === "success"),
    ).toHaveLength(3);
  });
});
