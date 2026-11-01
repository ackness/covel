// Aggregate existing local artifacts without copying model text or target identity.
const REASONS = [
  "invalid-json",
  "invalid-output",
  "missing-submission",
  "required-work",
  "review-rejected",
  "submission-batch",
  "superseded",
];
const STOPS = [
  "completed",
  "tool-finished",
  "max-steps",
  "deadline",
  "context-overflow",
  "cancelled",
  "model-error",
  "invalid-output",
  "loop-detected",
  "suspended",
];
const ORIGINS = [
  "player",
  "setup",
  "opening",
  "manual",
  "background",
  "recursive",
  "resume",
];
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const tally = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const rate = (n, d) => (d ? n / d : null);
const distribution = (values) => {
  const sorted = values
    .filter((v) => number(v) !== undefined)
    .sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
};

/** One attempt is a gate response, including content-only and mixed batches. */
export function submissionReport({ events, turns, sample }) {
  if (!["natural", "injected"].includes(sample))
    throw new Error("Choose natural or injected samples explicitly");
  if (!Array.isArray(events) || !Array.isArray(turns))
    throw new Error("Expected trace events and persisted turns arrays");
  const seen = new Set();
  const unique = events.filter((event) => {
    if (!event || typeof event !== "object")
      throw new Error("Invalid trace event");
    if (typeof event.id !== "string") return true;
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  // Resumes may have a new invocation ID while continuing the same logical loop.
  const parents = new Map();
  const root = (key) => {
    const visited = new Set();
    while (parents.has(key) && !visited.has(key)) {
      visited.add(key);
      key = parents.get(key);
    }
    return key;
  };
  for (const event of unique) {
    const p = event.payload ?? {};
    if (event.type === "runtime.started" && p.runId && p.resumeSourceRunId)
      parents.set(p.runId, root(p.resumeSourceRunId));
  }
  const records = new Map(turns.map((turn) => [turn.turnId, turn]));
  const phases = new Map();
  for (const event of unique) {
    const p = event.payload ?? {};
    const turnId = event.turnId ?? p.turnId;
    if (event.type === "turn.started" && p.origin === "continuation")
      phases.set(turnId, "opening");
    if (
      (event.type === "turn.started" &&
        p.recoveryAction?.type === "start_session") ||
      (event.type === "runtime.started" && p.stage === "setup")
    )
      phases.set(turnId, "setup");
  }
  const receipts = new Map();
  let conflictingReceipts = 0;
  const runs = new Map();
  const stepKeys = new Set();
  let duplicateSteps = 0;
  let rejectionCounterRegressions = 0;
  const reasons = tally(REASONS);
  const stops = tally(STOPS);
  const modelDurations = [];
  const commitDurations = [];
  const usage = {
    calls: 0,
    errorCalls: 0,
    missingUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheReadSamples: 0,
    cacheWriteSamples: 0,
  };
  let modelCalls = 0;
  let finalizerSteps = 0;
  let unknownRejections = 0;
  for (const event of unique) {
    const p = event.payload ?? {};
    if (
      ["execution.completed", "execution.round.completed"].includes(
        event.type,
      ) &&
      typeof p.committed === "boolean"
    ) {
      const turnId = event.turnId ?? p.turnId;
      if (turnId) {
        if (receipts.has(turnId) && receipts.get(turnId) !== p.committed)
          conflictingReceipts++;
        receipts.set(turnId, p.committed);
      }
    }
    if (event.type === "turn.completed" && number(p.durationMs) !== undefined)
      commitDurations.push(p.durationMs);
    if (event.type === "llm.calling") modelCalls++;
    if (
      ["llm.responded", "gateway.completed", "gateway.failed"].includes(
        event.type,
      )
    ) {
      usage.calls++;
      if (p.finishReason === "error" || event.type === "gateway.failed")
        usage.errorCalls++;
      if (number(p.durationMs) !== undefined) modelDurations.push(p.durationMs);
      if (
        number(p.usage?.inputTokens) === undefined ||
        number(p.usage?.outputTokens) === undefined
      )
        usage.missingUsage++;
      else {
        usage.inputTokens += p.usage.inputTokens;
        usage.outputTokens += p.usage.outputTokens;
      }
      for (const [field, samples] of [
        ["cachedInputTokens", "cacheReadSamples"],
        ["cacheWriteInputTokens", "cacheWriteSamples"],
      ]) {
        if (number(p.usage?.[field]) !== undefined) {
          usage[field] += p.usage[field];
          usage[samples]++;
        }
      }
    }
    if (event.type !== "step.completed") continue;
    if (!p.runId || !Number.isInteger(p.step))
      throw new Error("Step identity is required; use current trace artifacts");
    const key = root(p.runId);
    const stepKey = JSON.stringify([key, p.step]);
    if (stepKeys.has(stepKey)) {
      duplicateSteps++;
      continue;
    }
    stepKeys.add(stepKey);
    const run = runs.get(key) ?? {
      steps: 0,
      attempts: 0,
      eligibleAttempts: 0,
      rejected: 0,
      firstRejected: false,
      accepted: false,
      lastRejectionCounter: 0,
    };
    runs.set(key, run);
    run.steps++;
    if (p.finalizer === true) finalizerSteps++;
    if (STOPS.includes(p.stopReason)) stops[p.stopReason]++;
    const notes = Array.isArray(p.notes) ? p.notes : [];
    const rejection = notes.find((note) => note?.kind === "output-rejected");
    const submissions = (Array.isArray(p.toolCalls) ? p.toolCalls : []).filter(
      (call) => call?.name === "submit-output",
    );
    if (!rejection && !submissions.length) continue;
    run.attempts++;
    if (rejection?.reason !== "superseded") run.eligibleAttempts++;
    if (rejection) {
      if (REASONS.includes(rejection.reason)) reasons[rejection.reason]++;
      else unknownRejections++;
      if (number(rejection.attempt) !== undefined) {
        if (rejection.attempt <= run.lastRejectionCounter)
          rejectionCounterRegressions++;
        run.lastRejectionCounter = rejection.attempt;
      }
      // Supersession reflects new steering, rather than invalid model output.
      if (rejection.reason !== "superseded") {
        run.rejected++;
        if (run.eligibleAttempts === 1) run.firstRejected = true;
      }
    } else if (submissions.some((call) => call.success === true))
      run.accepted = true;
  }
  const commitOutcomes = Object.fromEntries(
    [...ORIGINS, "other"].map((origin) => [
      origin,
      { committed: 0, failed: 0, pending: 0, unverified: 0, disagreements: 0 },
    ]),
  );
  for (const [turnId, turn] of records) {
    const phase = phases.get(turnId) ?? turn.origin;
    const origin = ORIGINS.includes(phase) ? phase : "other";
    const row = commitOutcomes[origin];
    const status = turn.commitStatus;
    if (["committed", "failed", "pending"].includes(status)) row[status]++;
    if (!receipts.has(turnId)) row.unverified++;
    else if (receipts.get(turnId) !== (status === "committed"))
      row.disagreements++;
  }
  const resubmissions = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  const loops = [...runs.values()].filter((run) => run.attempts > 0);
  for (const run of loops) {
    const count = Math.max(0, run.attempts - 1);
    resubmissions[count >= 3 ? "3+" : String(count)]++;
  }
  const attempts = loops.reduce((sum, run) => sum + run.attempts, 0);
  const rejected = loops.reduce((sum, run) => sum + run.rejected, 0);
  const firstAttempts = loops.filter((run) => run.eligibleAttempts > 0).length;
  const firstRejected = loops.filter((run) => run.firstRejected).length;
  return {
    sample,
    gateResponses: {
      attempts,
      rejected,
      invalidRate: rate(rejected, attempts - reasons.superseded),
      firstAttempts,
      firstRejected,
      firstInvalidRate: rate(firstRejected, firstAttempts),
      reasons,
      unknownRejections,
    },
    loops: {
      observed: runs.size,
      accepted: loops.filter((run) => run.accepted).length,
      resubmissions,
      steps: stepKeys.size,
      finalizerSteps,
      stops,
      duplicateSteps,
      rejectionCounterRegressions,
    },
    commits: {
      byOrigin: commitOutcomes,
      conflictingReceipts,
      receiptsWithoutReadback: [...receipts.keys()].filter(
        (id) => !records.has(id),
      ).length,
    },
    model: {
      callingEvents: modelCalls,
      usage,
      responseDurationMs: distribution(modelDurations),
    },
    executionDurationMs: distribution(commitDurations),
    unmeasured: [
      "exact correction-budget exhaustion (terminal invalid-output alone is insufficient)",
      "cancelled versus infrastructure-unavailable action classification",
      "provider TTFB and admission-to-acceptance/commit/visible latency",
      "browser reveal, no-draft, bridge and message/proposal readback",
      "per-origin billed cost and token usage not reported by the provider",
    ],
  };
}
