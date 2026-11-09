import { submitted } from "./_helpers/agent-loop-fixture.js";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  RuntimeManifest,
  RuntimeResult,
  SetupRuntimeState,
  TurnInput,
} from "@covel/shared";
import { executeTurn } from "../src/execution.js";
import {
  commitExecution,
  refuseReleasedJobs,
} from "../src/commit/commit-execution.js";

// A story the framework holds back never writes a narrative. When that is
// because a runtime it hard depends on failed, the action must not commit:
// the turn would count and keep the other runtimes' writes with no story.
// When the package's own runtimes chose not to run, setup is still pending
// or a dependency cycle holds it back, the execution commits as before.

const SESSION = "session-held-back";
const TURN = "turn-held-back";

type Handler = () => HandlerResult;

const fn = (
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest => ({
  name,
  pluginId: name.split("/")[0]!,
  description: name,
  runtimeType: "function",
  stage: "pre-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  ...extra,
});

const story = (extra: Partial<RuntimeManifest> = {}): RuntimeManifest => ({
  name: "teller/narrate",
  pluginId: "teller",
  description: "Narrate the turn",
  stage: "narrative",
  outputKind: "story",
  trigger: { type: "auto" },
  ...extra,
});

/** An optional system plugin that writes beside the story every turn. */
const planner = fn("planner");
const plannerHandler: Handler = () => ({
  outcome: "success",
  value: {},
  effects: {
    pluginData: [{ namespace: "plan", key: "revealed", value: true }],
  },
});

async function playTurn(
  runtimes: readonly RuntimeManifest[],
  handlers: Readonly<Record<string, Handler>>,
  setupRuntimes: Record<string, SetupRuntimeState> = {},
  turn: Partial<TurnInput> = {},
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    locale: "en-US",
    id: SESSION,
    worldId: "world-held-back",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes,
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [...new Set(runtimes.map((runtime) => runtime.pluginId))],
    createdAt: now,
    updatedAt: now,
  });
  const execution = await executeTurn(
    {
      sessionId: SESSION,
      turnId: TURN,
      logicalTurnId: "logical-held-back",
      playerMessage: "Open the door.",
      origin: "player",
      ...turn,
    },
    runtimes,
    {
      store,
      llm: {
        generate: async () => submitted("The door creaks open."),
      },
      loadRuntime: async (loaded) => ({
        manifest: loaded,
        promptTemplate: "Write the story.",
        ...(loaded.runtimeType === "function"
          ? {
              handler: async () => {
                const handler = handlers[loaded.name];
                if (!handler) throw new Error(`no handler for ${loaded.name}`);
                return handler();
              },
            }
          : {}),
      }),
    },
  );
  const committed = await commitExecution({
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    store,
    execution,
    completion: { kind: "turn", turnId: TURN, durationMs: 0 },
  });
  const resultOf = (runtimeId: string) =>
    execution.result.runtimeResults.find(
      (result) => result.runtimeId === runtimeId,
    );
  const session = await store.getSession(SESSION);
  const plan = (
    await store.getPluginData(SESSION, "planner", "plan", "revealed")
  )?.value;
  return { committed, resultOf, session, plan, store };
}

const failingRoll: Handler = () => ({
  outcome: "failed",
  error: "The dice tray is empty",
});

describe("a story the framework held back", () => {
  it("does not commit or count an action whose story needs a runtime that failed", async () => {
    const { committed, resultOf, session, plan, store } = await playTurn(
      [planner, fn("teller/roll"), story({ needs: ["teller/roll"] })],
      { planner: plannerHandler, "teller/roll": failingRoll },
    );
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:needs" },
    });
    expect(committed.status).toBe("failed");
    expect(committed.error).toBe(
      "Story runtime teller/narrate did not run because teller/roll failed; the action was not committed.",
    );
    expect(session?.completedPlayerTurns).toBe(0);
    expect(plan).toBeFalsy();
    expect(await store.listTurnMessages(SESSION)).toHaveLength(0);
  });

  it("rejects a story whose required input comes from a runtime that failed", async () => {
    const { committed, resultOf, session, plan } = await playTurn(
      [
        planner,
        fn("teller/roll"),
        story({
          inputs: { roll: { from: { runtime: "teller/roll" } } },
        }),
      ],
      { planner: plannerHandler, "teller/roll": failingRoll },
    );
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:inputBinding" },
    });
    expect(committed.status).toBe("failed");
    expect(committed.error).toContain("because teller/roll failed");
    expect(session?.completedPlayerTurns).toBe(0);
    expect(plan).toBeFalsy();
  });

  it("traces the failure through an upstream the framework held back too", async () => {
    const { committed, resultOf, session } = await playTurn(
      [
        planner,
        fn("teller/roll"),
        fn("teller/judge", { needs: ["teller/roll"] }),
        story({ needs: ["teller/judge"] }),
      ],
      {
        planner: plannerHandler,
        "teller/roll": failingRoll,
        "teller/judge": () => ({ outcome: "success", value: {} }),
      },
    );
    expect(resultOf("teller/judge")?.status).toBe("skipped");
    expect(committed.status).toBe("failed");
    expect(committed.error).toContain("because teller/roll failed");
    expect(session?.completedPlayerTurns).toBe(0);
  });

  it("commits when the story is held back by a dependency cycle", async () => {
    // The scheduler also holds back everything after a cycle, `after` edges
    // included, so refusing would let a cycle anywhere stop every turn.
    // Validation and traces tell the author instead.
    const { committed, resultOf, session, plan } = await playTurn(
      [
        planner,
        fn("teller/roll", {
          stage: "narrative",
          needs: ["teller/narrate"],
        }),
        story({ needs: ["teller/roll"] }),
      ],
      { planner: plannerHandler, "teller/roll": failingRoll },
    );
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:dependencyCycle" },
    });
    expect(committed.status).toBe("committed");
    expect(session?.completedPlayerTurns).toBe(1);
    expect(plan).toBe(true);
  });

  it("commits when the story's upstream chose not to run", async () => {
    // The package's own declared gate stayed closed, as when the story's
    // guard skips it: no fault, so the action commits as before.
    const { committed, resultOf, session, plan } = await playTurn(
      [planner, fn("teller/roll"), story({ needs: ["teller/roll"] })],
      {
        planner: plannerHandler,
        "teller/roll": () => ({ outcome: "skipped", skipReason: "no check" }),
      },
    );
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:needs" },
    });
    expect(committed.status).toBe("committed");
    expect(session?.completedPlayerTurns).toBe(1);
    expect(plan).toBe(true);
  });

  it("commits when the story's upstream was not scheduled this turn", async () => {
    const { committed, resultOf, session } = await playTurn(
      [
        planner,
        fn("teller/roll", { stage: undefined, trigger: { type: "manual" } }),
        story({ needs: ["teller/roll"] }),
      ],
      { planner: plannerHandler, "teller/roll": failingRoll },
    );
    expect(resultOf("teller/roll")).toBeUndefined();
    expect(resultOf("teller/narrate")?.status).toBe("skipped");
    expect(committed.status).toBe("committed");
    expect(session?.completedPlayerTurns).toBe(1);
  });

  it("does not blame a failed provider of a contract another provider met", async () => {
    // Only the unscheduled check kept the gate closed: one `dice@1`
    // provider succeeded, which meets a `one` need despite the other's
    // failure.
    const { committed, resultOf, session } = await playTurn(
      [
        planner,
        fn("teller/check", { stage: undefined, trigger: { type: "manual" } }),
        fn("dice/a", { outputContract: "dice@1" }),
        fn("dice/b", { outputContract: "dice@1" }),
        story({ needs: ["teller/check", { capability: "dice@1" }] }),
      ],
      {
        planner: plannerHandler,
        "dice/a": () => ({ outcome: "success", value: {} }),
        "dice/b": failingRoll,
      },
    );
    expect(resultOf("dice/a")?.status).toBe("success");
    expect(resultOf("dice/b")?.status).toBe("failed");
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: {
        skippedBy: "framework:needs",
        missingUpstreams: ["teller/check"],
      },
    });
    expect(committed.status).toBe("committed");
    expect(session?.completedPlayerTurns).toBe(1);
  });

  it("blames a failed provider when no provider of a needed contract succeeded", async () => {
    const { committed, session } = await playTurn(
      [
        planner,
        fn("dice/a", { outputContract: "dice@1" }),
        fn("dice/b", { outputContract: "dice@1" }),
        story({ needs: [{ capability: "dice@1" }] }),
      ],
      {
        planner: plannerHandler,
        "dice/a": () => ({ outcome: "skipped", skipReason: "no roll" }),
        "dice/b": failingRoll,
      },
    );
    expect(committed.status).toBe("failed");
    expect(committed.error).toContain("because dice/b failed");
    expect(session?.completedPlayerTurns).toBe(0);
  });

  it("commits while the story's own setup is still pending", async () => {
    // A plugin enabled mid-session runs its setup first; until the player
    // completes it the story waits. Rejecting would discard the setup's own
    // writes (its form), so the player could never finish it.
    const { committed, resultOf, session, store } = await playTurn(
      [
        planner,
        fn("teller/intro", { stage: "setup" }),
        story({ needs: ["teller/roll"] }),
        fn("teller/roll"),
      ],
      {
        planner: plannerHandler,
        // Shows the player a form and waits for the answer: not done yet.
        "teller/intro": () => ({
          outcome: "success",
          value: {},
          effects: {
            pluginData: [{ namespace: "intro", key: "form", value: "shown" }],
          },
        }),
        "teller/roll": failingRoll,
      },
    );
    expect(resultOf("teller/intro")?.status).toBe("success");
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:setupGate" },
    });
    expect(committed.status).toBe("committed");
    expect(session?.setupRuntimes["teller/intro"]?.state).toBe("pending");
    expect(
      (await store.getPluginData(SESSION, "teller", "intro", "form"))?.value,
    ).toBe("shown");
  });

  it("commits when another story produced the narrative", async () => {
    const { committed, resultOf, session, plan } = await playTurn(
      [
        planner,
        fn("teller/roll"),
        story({ needs: ["teller/roll"] }),
        story({ name: "bard/sing", pluginId: "bard" }),
      ],
      { planner: plannerHandler, "teller/roll": failingRoll },
    );
    expect(resultOf("teller/narrate")?.status).toBe("skipped");
    expect(resultOf("bard/sing")?.status).toBe("success");
    expect(committed.status).toBe("committed");
    expect(session?.completedPlayerTurns).toBe(1);
    expect(plan).toBe(true);
  });

  it("records the failed runtime on every gate it passes through", async () => {
    const { resultOf } = await playTurn(
      [
        fn("teller/roll"),
        fn("teller/judge", { needs: ["teller/roll"] }),
        story({ needs: ["teller/judge"] }),
      ],
      {
        "teller/roll": failingRoll,
        "teller/judge": () => ({ outcome: "success", value: {} }),
      },
    );
    expect(resultOf("teller/judge")?.output).toMatchObject({
      failedUpstream: "teller/roll",
    });
    expect(resultOf("teller/narrate")?.output).toMatchObject({
      failedUpstream: "teller/roll",
    });
  });

  it("does not blame an upstream that failed in the retried turn", async () => {
    // A retry reads the source turn's results; their failures were settled
    // with that turn, not in this execution.
    const seed: RuntimeResult = {
      pluginId: "teller",
      runtimeId: "teller/roll",
      runId: "roll-source",
      turnId: "turn-source",
      status: "failed",
      output: null,
      error: "The dice tray is empty",
      toolCalls: [],
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };
    const { committed, resultOf } = await playTurn(
      [fn("teller/roll"), story({ needs: ["teller/roll"] })],
      {},
      {},
      {
        origin: "manual",
        manualTrigger: {
          runtimeId: "teller/narrate",
          sourceTurnId: "turn-source",
          retrySeedResults: [seed],
        },
      },
    );
    expect(resultOf("teller/narrate")).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:needs" },
    });
    expect(resultOf("teller/narrate")?.output).not.toHaveProperty(
      "failedUpstream",
    );
    expect(committed.status).toBe("committed");
  });
});
