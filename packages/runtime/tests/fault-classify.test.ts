import { describe, expect, it } from "vitest";
import type { LoopStop, RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { FinalizeExecutionOutcome } from "../src/commit/finalize-execution.js";
import {
  classifyExecutionFaults,
  type SubagentRunOutcome,
} from "../src/faults/classify.js";
import { finalizeRuntimeResult } from "../src/turn-executor/runtime-finalization.js";
import { RuntimeTimeoutError } from "../src/turn-executor/turn-control.js";
import { AiProviderError } from "@covel/ai-provider";
import { tagStop } from "../src/agent-loop/stop-reason.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runPreStateCommitHook } from "../src/commit/session-commit-pipeline.js";

function faultResult(extra: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    pluginId: "p",
    runtimeId: "p/run",
    runId: "run",
    turnId: "turn",
    status: "failed",
    output: null,
    toolCalls: [],
    durationMs: 0,
    timestamp: "2026-10-29T00:00:00Z",
    ...extra,
  };
}
const committed: FinalizeExecutionOutcome = {
  status: "committed",
  events: [],
  failedProposals: [],
  operations: [],
};
const rejected = (code?: string): FinalizeExecutionOutcome => ({
  status: "failed",
  events: [],
  operations: [],
  failedProposals: [
    {
      proposal: {
        id: "proposal",
        type: "plugin.data",
        sessionId: "s",
        turnId: "turn",
        timestamp: "2026-10-29T00:00:00Z",
        source: { pluginId: "p", runtimeId: "p/run" },
        payload: { namespace: "data", key: "key", value: true },
      },
      error: "rejected",
      ...(code ? { code } : {}),
    },
  ],
});
const manifest: RuntimeManifest = {
  pluginId: "p",
  name: "p/run",
  runtimeType: "function",
  stage: "post-turn",
  description: "probe",
};

describe("sub-agent runs", () => {
  const failed: SubagentRunOutcome = {
    pluginId: "actor-pkg",
    callerRuntimeId: "caller-pkg/main",
    ok: false,
    fault: "runtime",
  };
  const clean: SubagentRunOutcome = { ...failed, ok: true, fault: undefined };

  it("attributes a provider fault separately from its successful caller", () => {
    expect(
      classifyExecutionFaults(
        [
          faultResult({
            pluginId: "caller-pkg",
            runtimeId: failed.callerRuntimeId,
            status: "success",
          }),
        ],
        committed,
        undefined,
        [failed],
      ),
    ).toEqual(
      new Map([
        ["caller-pkg", { kind: "clean" }],
        ["actor-pkg", { kind: "fault", reason: "runtime" }],
      ]),
    );
  });
  it.each(["committed", "failed"] as const)(
    "resets only under a committed outcome: %s",
    (status) => {
      expect(
        classifyExecutionFaults([], { ...committed, status }, undefined, [
          clean,
        ]).get("actor-pkg"),
      ).toEqual({ kind: status === "committed" ? "clean" : "neutral" });
      expect(
        classifyExecutionFaults([], { ...committed, status }, undefined, [
          failed,
        ]).get("actor-pkg"),
      ).toEqual({ kind: "fault", reason: "runtime" });
    },
  );
  it.each([
    [failed, clean],
    [clean, failed],
  ])("gives faults priority in either run order: %j", (...runs) => {
    expect(
      classifyExecutionFaults([], committed, undefined, runs).get("actor-pkg"),
    ).toEqual({ kind: "fault", reason: "runtime" });
  });
  it("does not count or reset providers called by setup runtimes", () => {
    expect(
      classifyExecutionFaults(
        [],
        committed,
        new Set([failed.callerRuntimeId]),
        [failed, clean],
      ).size,
    ).toBe(0);
  });
  it("keeps the entire stale suspension attempt neutral", () => {
    expect(
      classifyExecutionFaults(
        [],
        { ...committed, status: "failed", code: "suspension-data-changed" },
        undefined,
        [failed],
      ).size,
    ).toBe(0);
  });
  it("keeps an unattributed provider failure neutral", () => {
    expect(
      classifyExecutionFaults([], committed, undefined, [
        { ...failed, fault: undefined },
      ]).get("actor-pkg"),
    ).toEqual({ kind: "neutral" });
  });
  it("allows a provider to reset even if the caller's commit unit was isolated", () => {
    expect(
      classifyExecutionFaults(
        [],
        {
          ...committed,
          isolatedRuntimes: [
            {
              runtimeId: failed.callerRuntimeId,
              cause: "nested",
              error: "caller isolated",
            },
          ],
        },
        undefined,
        [clean],
      ).get("actor-pkg"),
    ).toEqual({ kind: "clean" });
  });
});

describe("self-caused runtime attribution", () => {
  it.each<{
    name: string;
    cause?: Error;
    stop?: LoopStop;
    extra?: Partial<RuntimeResult>;
    abort?: boolean;
    setup?: boolean;
    expected?: string;
  }>([
    { name: "plugin-supplied marker", extra: { fault: "runtime" } },
    {
      name: "plugin throw",
      cause: new Error("plugin failed"),
      expected: "runtime",
    },
    {
      name: "own function timeout",
      cause: new RuntimeTimeoutError("deadline"),
      expected: "timeout",
    },
    {
      name: "parent timeout",
      cause: new RuntimeTimeoutError("parent deadline"),
      abort: true,
    },
    {
      name: "provider exception",
      cause: new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "remote",
        message: "network failed",
        retriable: true,
      }),
    },
    {
      name: "provider failureTarget",
      cause: new Error("provider failed"),
      extra: { failureTarget: { provider: "remote" } },
    },
    {
      name: "provider prefix",
      cause: new Error("provider failed"),
      extra: { error: "[provider: remote] failed" },
    },
    {
      name: "model-error",
      cause: new Error("model failed"),
      stop: { reason: "model-error" },
    },
    {
      name: "agent own deadline",
      stop: { reason: "deadline" },
      expected: "timeout",
    },
    {
      name: "agent max steps",
      stop: { reason: "max-steps" },
      expected: "runtime",
    },
    {
      name: "agent invalid output",
      stop: { reason: "invalid-output" },
      expected: "runtime",
    },
    {
      name: "agent loop",
      stop: { reason: "loop-detected" },
      expected: "runtime",
    },
    {
      name: "context overflow",
      stop: { reason: "context-overflow" },
      expected: "runtime",
    },
    {
      name: "rescued context overflow",
      stop: { reason: "context-overflow", finalizer: true },
      extra: { status: "success", error: undefined },
    },
    ...(["player", "parent", "hook", "host"] as const).map((cancelledBy) => ({
      name: `cancelled by ${cancelledBy}`,
      cause: new RuntimeTimeoutError("cancel"),
      stop: { reason: "cancelled" as const, cancelledBy },
    })),
    { name: "setup throw", cause: new Error("setup failed"), setup: true },
    {
      name: "suspended",
      cause: new Error("waiting"),
      extra: { status: "suspended" },
    },
    {
      name: "skipped",
      cause: new Error("missing upstream"),
      extra: { status: "skipped" },
    },
    {
      name: "ordinary errorKind is not provider ownership",
      cause: new Error("plugin failed"),
      extra: { errorKind: "unknown" },
      expected: "runtime",
    },
  ])("$name", async ({ cause, stop, extra, abort, setup, expected }) => {
    const controller = new AbortController();
    if (abort) controller.abort(new RuntimeTimeoutError("parent timeout"));
    if (cause && stop) tagStop(cause, stop, "run");
    const result = await finalizeRuntimeResult(
      { turnControl: { executionSignal: controller.signal } },
      { ...manifest, ...(setup ? { stage: "setup" as const } : {}) },
      { sessionId: "s", turnId: "turn", playerMessage: "", origin: "player" },
      faultResult({
        error: cause?.message ?? "failed",
        ...(stop ? { stop } : {}),
        ...extra,
      }),
      { cause },
    );
    expect(result.fault).toBe(expected);
  });
});

describe("stop tags are scoped to the run that made them", () => {
  const input = {
    sessionId: "s",
    turnId: "turn",
    playerMessage: "",
    origin: "player" as const,
  };
  it("keeps a child's cancellation off the parent whose deadline caused it", async () => {
    // The parent's deadline abort reaches the child it awaits as the same
    // error object, and the child's loop tags it cancelled by the parent.
    const shared = new RuntimeTimeoutError("parent deadline");
    tagStop(
      shared,
      { reason: "cancelled", cancelledBy: "parent" },
      "child-run",
    );

    const parent = await finalizeRuntimeResult(
      {},
      manifest,
      input,
      faultResult({ runId: "parent-run", error: shared.message }),
      { cause: shared },
    );
    expect(parent.stop).toBeUndefined();
    expect(parent.fault).toBe("timeout");

    const controller = new AbortController();
    controller.abort(shared);
    const child = await finalizeRuntimeResult(
      { turnControl: { executionSignal: controller.signal } },
      { ...manifest, name: "p/child" },
      input,
      faultResult({
        runId: "child-run",
        runtimeId: "p/child",
        error: shared.message,
      }),
      { cause: shared },
    );
    expect(child.stop).toEqual({ reason: "cancelled", cancelledBy: "parent" });
    expect(child.fault).toBeUndefined();
  });
});

describe("execution fault classification", () => {
  it.each<
    [string, RuntimeResult, FinalizeExecutionOutcome, string | undefined]
  >([
    ["runtime", faultResult({ fault: "runtime" }), committed, "fault"],
    ["timeout", faultResult({ fault: "timeout" }), committed, "fault"],
    [
      "unattributed provider",
      faultResult({
        errorKind: "unknown",
        failureTarget: { provider: "remote" },
      }),
      committed,
      "neutral",
    ],
    [
      "scheduler skip",
      faultResult({ status: "skipped" }),
      committed,
      "neutral",
    ],
    ["suspended", faultResult({ status: "suspended" }), committed, "neutral"],
    ["clean committed", faultResult({ status: "success" }), committed, "clean"],
    [
      "innocent rollback",
      faultResult({ status: "success" }),
      { ...committed, status: "failed" },
      "neutral",
    ],
    ["proposal veto", faultResult({ status: "success" }), rejected(), "fault"],
    [
      "commit handler rejection",
      faultResult({ status: "success" }),
      rejected("proposal-invalid"),
      "fault",
    ],
    [
      "another hook failed",
      faultResult({ status: "success" }),
      rejected("hook-failed"),
      "neutral",
    ],
    [
      "dimension conflict",
      faultResult({ status: "success" }),
      rejected("dimension-version-conflict"),
      "neutral",
    ],
    [
      "operation write conflict",
      faultResult({ status: "success" }),
      rejected("conflict"),
      "neutral",
    ],
    [
      "stale suspension",
      faultResult({ fault: "runtime" }),
      { ...committed, status: "failed", code: "suspension-data-changed" },
      undefined,
    ],
    ...(["upstream", "read", "nested"] as const).map(
      (cause) =>
        [
          cause,
          faultResult({ status: "success" }),
          {
            ...committed,
            isolatedRuntimes: [
              { runtimeId: "p/run", runId: "run", cause, error: "cascade" },
            ],
          },
          "neutral",
        ] as [string, RuntimeResult, FinalizeExecutionOutcome, string],
    ),
  ])("%s", (_name, result, outcome, expected) => {
    expect(classifyExecutionFaults([result], outcome).get("p")?.kind).toBe(
      expected,
    );
  });
  it("excludes setup proposal rejection and setup result faults", () => {
    expect(
      classifyExecutionFaults(
        [faultResult({ fault: "runtime" })],
        rejected(),
        new Set(["p/run"]),
      ).size,
    ).toBe(0);
  });
  it("gives faults priority over another successful runtime of the same plugin", () => {
    expect(
      classifyExecutionFaults(
        [faultResult({ fault: "runtime" }), faultResult({ status: "success" })],
        committed,
      ).get("p"),
    ).toEqual({ kind: "fault", reason: "runtime" });
  });
  it("matches isolation by run, allowing a clean nested run of the same runtime", () => {
    expect(
      classifyExecutionFaults(
        [faultResult({ status: "success", runId: "other" })],
        {
          ...committed,
          isolatedRuntimes: [
            {
              runtimeId: "p/run",
              runId: "run",
              cause: "nested",
              error: "cascade",
            },
          ],
        },
      ).get("p")?.kind,
    ).toBe("clean");
  });
  it("marks hook throws separately from deliberate proposal vetoes", async () => {
    const pipeline = createHookPipeline();
    const proposal = rejected().failedProposals[0]?.proposal;
    if (!proposal || proposal.type === "effects.invalid")
      throw new Error("fixture missing");
    pipeline.register({
      id: "hook",
      pluginId: "hook-owner",
      event: "PreStateCommit",
      handler: async () => {
        throw new Error("broken hook");
      },
    });
    expect(await runPreStateCommitHook(pipeline, proposal)).toMatchObject({
      code: "hook-failed",
    });
    pipeline.clear();
    pipeline.register({
      id: "hook",
      pluginId: "hook-owner",
      event: "PreStateCommit",
      handler: async () => ({ action: "abort", reason: "policy veto" }),
    });
    expect(await runPreStateCommitHook(pipeline, proposal)).toEqual({
      error: "pre-state-commit hook aborted: policy veto",
    });
  });
});
