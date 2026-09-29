import { expect, it } from "vitest";
import { parseStagedRuntimeJobPayload } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";

it("restores the source digest through the shared schema and rejects obsolete or mismatched snapshots", () => {
  const payload = {
    schemaVersion: 1,
    expectedSessionIncarnation: "incarnation",
    expectedApprovalScope: "approved",
    locale: "en",
    descriptor: {
      jobId: "job",
      pluginId: "memory",
      runtimeId: "memory/extract",
      sourceTurnId: "source",
      sourceExecutionId: "execution",
      sourceExecutionStartedAt: "2026-09-28T00:00:00Z",
      upstreamResults: [],
      turnDigest: {
        turnId: "source",
        playerMessage: "Go",
        lastPlayerInput: {
          id: "input-a",
          sessionId: "session",
          turnId: "earlier",
          formId: "profile",
          values: { name: "Alice" },
          createdAt: "2026-09-28T00:00:00Z",
        },
        narrativeText: "Story",
        toolCallSummaries: [],
        runtimeResults: [{ runtimeId: "story", status: "success" }],
      },
    },
  };
  expect(
    parseStagedRuntimeJobPayload(JSON.parse(JSON.stringify(payload)))
      ?.descriptor.turnDigest,
  ).toEqual(payload.descriptor.turnDigest);
  for (const turnDigest of [
    undefined,
    { ...payload.descriptor.turnDigest, lastPlayerInput: "Go" },
    { ...payload.descriptor.turnDigest, runtimeResults: undefined },
    { ...payload.descriptor.turnDigest, turnId: "another" },
  ]) {
    expect(
      parseStagedRuntimeJobPayload({
        ...payload,
        descriptor: { ...payload.descriptor, turnDigest },
      }),
    ).toBeUndefined();
  }
});
