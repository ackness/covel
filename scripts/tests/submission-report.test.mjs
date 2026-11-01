import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { submissionReport } from "../lib/submission-report.mjs";
import { concealTracePayload } from "../../packages/shared/src/utils/concealed-runtime.ts";

const step = (runId, n, reason, extra = {}) => ({
  type: "step.completed",
  turnId: "turn",
  payload: {
    runId,
    step: n,
    toolCalls:
      reason === "missing-submission"
        ? []
        : [{ name: "submit-output", success: !reason }],
    notes: reason ? [{ kind: "output-rejected", reason, attempt: n }] : [],
    ...extra,
  },
});
const report = (events, turns = []) =>
  submissionReport({ events, turns, sample: "natural" });

test("counts missing content-only and mixed batches once without double-counting failed calls", () => {
  const result = report([
    step("a", 1, "missing-submission"),
    { type: "tool.failed", payload: { toolName: "submit-output" } },
    step("a", 2),
    step("b", 1, "submission-batch", {
      toolCalls: [
        { name: "write", success: false },
        { name: "submit-output", success: false },
      ],
    }),
    step("b", 2),
  ]);
  assert.equal(result.gateResponses.attempts, 4);
  assert.equal(result.gateResponses.rejected, 2);
  assert.equal(result.gateResponses.firstRejected, 2);
  assert.equal(result.gateResponses.invalidRate, 0.5);
  assert.deepEqual(result.loops.resubmissions, { 0: 0, 1: 2, 2: 0, "3+": 0 });
});

test("reports all rejection categories, finalizer and terminal bounds separately", () => {
  const events = [
    "invalid-json",
    "invalid-output",
    "required-work",
    "review-rejected",
    "superseded",
  ].map((reason, i) =>
    step(String(i), 1, reason, {
      finalizer: true,
      stopReason: "invalid-output",
    }),
  );
  const result = report(events);
  assert.equal(result.gateResponses.rejected, 4);
  assert.equal(result.gateResponses.invalidRate, 1);
  assert.equal(result.loops.finalizerSteps, 5);
  assert.equal(result.loops.stops["invalid-output"], 5);
  assert.ok(result.unmeasured.some((v) => v.includes("budget exhaustion")));
});

test("joins resume identities and preserves rejection counters across the logical loop", () => {
  const events = [
    step("before", 1, "invalid-json"),
    {
      type: "runtime.started",
      payload: { runId: "after", resumeSourceRunId: "before" },
    },
    step("after", 2, "invalid-output"),
    step("after", 3),
  ];
  assert.equal(report(events).loops.observed, 1);
  assert.equal(report(events).loops.resubmissions["2"], 1);
  assert.equal(
    report([
      ...events,
      step("after", 4, "invalid-json", {
        notes: [
          { kind: "output-rejected", reason: "invalid-json", attempt: 1 },
        ],
      }),
    ]).loops.rejectionCounterRegressions,
    1,
  );
});

test("deduplicates trace IDs but flags repeated logical steps rather than counting them twice", () => {
  const one = { ...step("a", 1), id: "same" };
  const result = report([one, one, { ...one, id: "different" }]);
  assert.equal(result.gateResponses.attempts, 1);
  assert.equal(result.loops.duplicateSteps, 1);
});

test("accepted output is not a persisted commit; receipts must agree with readback", () => {
  const events = [
    step("a", 1),
    {
      type: "execution.round.completed",
      turnId: "turn",
      payload: { committed: false },
    },
  ];
  const failed = report(events, [
    { turnId: "turn", origin: "player", commitStatus: "failed" },
  ]);
  assert.equal(failed.loops.accepted, 1);
  assert.equal(failed.commits.byOrigin.player.failed, 1);
  assert.equal(failed.commits.byOrigin.player.committed, 0);
  assert.equal(failed.commits.byOrigin.player.disagreements, 0);
  assert.equal(
    report(events, [
      { turnId: "turn", origin: "player", commitStatus: "committed" },
    ]).commits.byOrigin.player.disagreements,
    1,
  );
  assert.equal(
    report(
      [],
      [{ turnId: "turn", origin: "player", commitStatus: "committed" }],
    ).commits.byOrigin.player.unverified,
    1,
  );
});

test("separates setup and opening from player turns", () => {
  const result = report(
    [
      { type: "runtime.started", turnId: "setup", payload: { stage: "setup" } },
      {
        type: "turn.started",
        turnId: "opening",
        payload: { origin: "continuation" },
      },
    ],
    ["setup", "opening", "player"].map((turnId) => ({
      turnId,
      origin: turnId === "opening" ? "continuation" : "player",
      commitStatus: "committed",
    })),
  );
  for (const phase of ["setup", "opening", "player"])
    assert.equal(result.commits.byOrigin[phase].committed, 1);
});

test("includes failed billed calls and reports unknown usage and latency sample sizes", () => {
  const result = report([
    { type: "llm.calling", payload: {} },
    {
      type: "llm.responded",
      payload: {
        finishReason: "error",
        durationMs: 20,
        usage: { inputTokens: 13, outputTokens: 2, cachedInputTokens: 5 },
      },
    },
    { type: "gateway.failed", payload: { durationMs: 40 } },
  ]);
  assert.equal(result.model.usage.inputTokens, 13);
  assert.equal(result.model.usage.errorCalls, 2);
  assert.equal(result.model.usage.missingUsage, 1);
  assert.equal(result.model.usage.cacheReadSamples, 1);
  assert.deepEqual(result.model.responseDurationMs, {
    samples: 2,
    p50: 20,
    p95: 40,
  });
});

test("includes successful function gateway calls in usage, cache and duration totals", () => {
  const result = report([
    { type: "llm.calling", payload: {} },
    { type: "gateway.calling", payload: {} },
    { type: "gateway.calling", payload: {} },
    {
      type: "llm.responded",
      payload: {
        durationMs: 10,
        usage: { inputTokens: 7, outputTokens: 3 },
      },
    },
    {
      type: "gateway.responded",
      payload: {
        text: "PRIVATE gateway result",
        durationMs: 20,
        usage: {
          inputTokens: 11,
          outputTokens: 5,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 2,
        },
      },
    },
    {
      type: "gateway.failed",
      payload: { durationMs: 30, usage: { inputTokens: 2, outputTokens: 1 } },
    },
  ]);
  assert.equal(result.model.callingEvents, 3);
  assert.deepEqual(result.model.usage, {
    calls: 3,
    errorCalls: 1,
    missingUsage: 0,
    inputTokens: 20,
    outputTokens: 9,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 2,
    cacheReadSamples: 1,
    cacheWriteSamples: 1,
  });
  assert.deepEqual(result.model.responseDurationMs, {
    samples: 3,
    p50: 20,
    p95: 30,
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("counts concealed correction and first-try success after the real privacy projection", () => {
  const events = [
    step("corrected", 1, "invalid-output"),
    step("corrected", 2, undefined, { stopReason: "completed" }),
    // Successful finalizers need not have stopReason=completed.
    step("first", 1, undefined, { finalizer: true, stopReason: "max-steps" }),
  ].map((event) => ({
    ...event,
    payload: concealTracePayload({
      ...event.payload,
      toolCalls: [
        ...event.payload.toolCalls,
        {
          name: "PRIVATE business tool",
          success: true,
          arguments: "PRIVATE args",
          output: "PRIVATE output",
        },
      ],
      text: "PRIVATE draft",
    }),
  }));
  for (const event of events) assert.equal(event.payload.toolCalls, undefined);
  const result = report(events);
  assert.equal(result.gateResponses.attempts, 3);
  assert.equal(result.gateResponses.rejected, 1);
  assert.equal(result.gateResponses.invalidRate, 1 / 3);
  assert.equal(result.gateResponses.firstAttempts, 2);
  assert.equal(result.gateResponses.firstInvalidRate, 0.5);
  assert.equal(result.loops.accepted, 2);
  assert.deepEqual(result.loops.resubmissions, { 0: 1, 1: 1, 2: 0, "3+": 0 });
  assert.doesNotMatch(JSON.stringify({ events, result }), /PRIVATE/);
});

test("does not copy arbitrary strings, keys, origins, concealed content or identifiers into output", () => {
  const secret = "PRIVATE_SECRET_https://private.invalid";
  const result = report([
    {
      ...step(secret, 1, "invalid-json"),
      payload: {
        ...step(secret, 1, "invalid-json").payload,
        concealed: true,
        text: secret,
        arguments: secret,
        reason: secret,
        provider: secret,
        headers: { authorization: secret },
      },
    },
  ]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.gateResponses.reasons["invalid-json"], 1);
  assert.throws(() =>
    submissionReport({ events: [], turns: [], sample: "unspecified" }),
  );
  assert.equal(
    submissionReport({ events: [], turns: [], sample: "injected" }).sample,
    "injected",
  );
});

test("CLI parse and file errors cannot echo private input paths or text", (t) => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/submission-report.mjs",
      "--traces",
      "/PRIVATE_SECRET",
      "--turns",
      "/PRIVATE_SECRET",
      "--lane",
      "official-openai",
      "--sample",
      "natural",
    ],
    { encoding: "utf8" },
  );
  if (result.error?.code === "EPERM") {
    t.skip(
      "Sandbox blocks subprocess execution; coordinator must verify CLI errors",
    );
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /PRIVATE_SECRET/);
});

test("steering supersession does not dilute the first model-invalidity denominator", () => {
  const result = report([
    step("a", 1, "superseded"),
    step("a", 2, "invalid-output"),
    step("b", 1, "superseded"),
  ]);
  assert.equal(result.gateResponses.firstAttempts, 1);
  assert.equal(result.gateResponses.firstRejected, 1);
  assert.equal(result.gateResponses.firstInvalidRate, 1);
});
