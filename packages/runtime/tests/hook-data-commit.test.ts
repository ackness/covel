import { describe, expect, it } from "vitest";
import type { ProposalFor, RuntimeResult } from "@covel/shared";
import { createMemoryStore, type SuspensionRecord } from "@covel/store";
import {
  getEmittedEvents,
  getPendingProposals,
  withEmittedEvents,
  withPendingProposals,
} from "@covel/tools";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runPostRuntimeHook } from "../src/hooks/wire-helpers.js";
import { createCommitPipeline } from "../src/commit/session-commit-pipeline.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import {
  attachExecutionJournal,
  collectExecutionJournal,
} from "../src/execution-journal.js";
import {
  attachSuspensionArtifact,
  collectExecutionSuspensions,
} from "../src/suspension-artifact.js";

const now = "2026-09-19T00:00:00.000Z";
const context = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "probe",
  runtimeId: "probe/main",
};

function proposal(): ProposalFor<"plugin.data"> {
  return {
    id: "proposal",
    type: "plugin.data",
    source: { pluginId: "probe", runtimeId: "probe/main" },
    sessionId: "session",
    turnId: "turn",
    timestamp: now,
    payload: { namespace: "entries", key: "value", value: "original" },
  };
}

function result(output: Record<string, unknown>): RuntimeResult {
  return {
    pluginId: "probe",
    runtimeId: "probe/main",
    runId: "run",
    turnId: "turn",
    status: "success",
    output,
    toolCalls: [],
    durationMs: 1,
    timestamp: now,
  };
}

describe("Hook data at the commit boundary", () => {
  it.each([false, true])(
    "pins the proposal envelope and only accepts explicit payload rewrites (replace=%s)",
    async (replace) => {
      const store = createMemoryStore();
      const pipeline = createHookPipeline();
      const original = proposal();
      pipeline.register<{ proposal: ReturnType<typeof proposal> }>({
        id: "rewrite",
        event: "PreStateCommit",
        async handler(_ctx, payload) {
          Object.assign(payload.proposal, {
            id: "forged",
            type: "plugin.data.delete",
            sessionId: "other-session",
            turnId: "other-turn",
          });
          Object.assign(payload.proposal.source, {
            pluginId: "other-plugin",
            runtimeId: "other-runtime",
          });
          Object.assign(payload.proposal.payload, { value: "rewritten" });
          return replace
            ? { action: "continue", replace: payload }
            : { action: "continue" };
        },
      });
      pipeline.register<{ result: { committed: boolean } }>({
        id: "observe",
        event: "PostStateCommit",
        async handler(_ctx, payload) {
          payload.result.committed = false;
          return { action: "continue" };
        },
      });
      try {
        expect(
          await createCommitPipeline(store, pipeline).commit(original),
        ).toMatchObject({ committed: true });
        expect(
          await store.getPluginData("session", "probe", "entries", "value"),
        ).toMatchObject({ value: replace ? "rewritten" : "original" });
        expect(
          await store.getPluginData(
            "other-session",
            "other-plugin",
            "entries",
            "value",
          ),
        ).toBeNull();
        expect(original).toEqual(proposal());
      } finally {
        await store.close();
      }
    },
  );

  it("retains tool proposals and events across a returned runtime rewrite and commits the owned proposal", async () => {
    const store = createMemoryStore();
    const pipeline = createHookPipeline();
    const pending = proposal();
    const event = { topic: "probe.updated", data: { value: "original" } };
    const original = result(
      withPendingProposals(withEmittedEvents({ value: "original" }, [event]), [
        pending,
      ]),
    );
    pipeline.register<{ result: RuntimeResult }>({
      id: "rewrite",
      event: "PostRuntime",
      async handler(_ctx, payload) {
        return {
          action: "continue",
          replace: {
            result: { ...payload.result, output: payload.result.output },
          },
        };
      },
    });
    try {
      const accepted = await runPostRuntimeHook(
        { pipeline, ...context },
        original,
      );
      Object.assign(pending.payload, { value: "late producer write" });
      event.data.value = "late producer write";
      expect(getPendingProposals(accepted.output)).toHaveLength(1);
      expect(getEmittedEvents(accepted.output)).toEqual([
        { topic: "probe.updated", data: { value: "original" } },
      ]);
      expect(JSON.stringify(accepted.output)).toBe('{"value":"original"}');
      const committed = await finalizeExecution({
        store,
        sessionId: "session",
        executionContext: {
          executionId: "execution",
          origin: "manual",
          countPolicy: "none",
        },
        runtimes: [
          {
            name: "probe/main",
            pluginId: "probe",
            outputKind: "plugin",
            capabilities: [],
          },
        ],
        results: [accepted],
        turnIds: [],
      });
      expect(committed.status).toBe("committed");
      expect(
        await store.getPluginData("session", "probe", "entries", "value"),
      ).toMatchObject({ value: "original" });
    } finally {
      await store.close();
    }
  });

  it("keeps conversation and suspension artifacts visible to observers without lending ownership", async () => {
    const pipeline = createHookPipeline();
    const runtime = result({});
    const journal = {
      id: "message",
      sessionId: "session",
      turnId: "turn",
      sourceType: "runtime" as const,
      sourcePluginId: "probe",
      sourceRuntimeId: "probe/main",
      role: "assistant" as const,
      content: "original",
      order: 1,
      createdAt: now,
    };
    const suspension: SuspensionRecord = {
      id: "suspension",
      sessionId: "session",
      turnId: "turn",
      pluginId: "probe",
      runtimeId: "probe/main",
      reason: "wait",
      resumeSchema: {},
      createdAt: now,
      pendingContinuation: {
        executionContext: {
          executionId: "execution",
          origin: "manual",
          countPolicy: "none",
        },
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: [proposal()],
      },
    };
    attachExecutionJournal(runtime, [journal]);
    attachSuspensionArtifact(runtime, { record: suspension });
    const turn = { runtimeResults: [runtime] };
    let observedMessages: unknown;
    let observedSuspensions: unknown;
    pipeline.register<typeof turn>({
      id: "observe",
      event: "TurnStop",
      async handler(_ctx, payload) {
        const messages = collectExecutionJournal(payload);
        const suspensions = collectExecutionSuspensions(payload);
        observedMessages = structuredClone(messages);
        observedSuspensions = structuredClone(suspensions);
        Object.assign(messages[0]!, { content: "observer write" });
        Object.assign(suspensions[0]!, { reason: "observer write" });
        Object.assign(
          suspensions[0]!.pendingContinuation.pendingProposals[0]!.payload,
          { value: "observer write" },
        );
        return { action: "continue" };
      },
    });
    await pipeline.run("TurnStop", { event: "TurnStop", ...context }, turn);
    expect(observedMessages).toEqual([journal]);
    expect(observedSuspensions).toEqual([suspension]);
    expect(collectExecutionJournal(turn)[0]!.content).toBe("original");
    expect(collectExecutionSuspensions(turn)[0]!.reason).toBe("wait");
    expect(
      collectExecutionSuspensions(turn)[0]!.pendingContinuation
        .pendingProposals[0]!.payload,
    ).toMatchObject({ value: "original" });
    expect(JSON.stringify(turn)).not.toContain("pendingContinuation");
  });
});
