import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/runtime";
import type { PluginRuntimeGateway } from "@covel/plugin-loader";
import {
  createJobCredentialHandoff,
  createRuntimeJobCredentials,
} from "../../src/routes/api/plugin-rpc/runtime-job-credentials.js";

const key = {
  jobId: "job",
  sessionId: "session",
  expectedSessionIncarnation: "incarnation",
};
const services = { llm: {} as LLMAdapter, gateway: {} as PluginRuntimeGateway };
afterEach(() => vi.useRealTimers());

describe("runtime job request services", () => {
  it("keeps adapter and gateway together, prioritizes the original request, and consumes once", () => {
    const credentials = createRuntimeJobCredentials();
    credentials.register(key, services);
    credentials.provide([key], { llm: {} as LLMAdapter });
    expect(credentials.peek(key)).toBe(services);
    expect(credentials.take(key)).toBe(services);
    expect(credentials.take(key)).toBeUndefined();
    expect(credentials.size).toBe(0);
  });

  it("does not lend across sessions or incarnations and clears rollback handoffs", () => {
    const credentials = createRuntimeJobCredentials();
    credentials.register(key, services);
    expect(credentials.take({ ...key, sessionId: "other" })).toBeUndefined();
    expect(
      credentials.take({ ...key, expectedSessionIncarnation: "replacement" }),
    ).toBeUndefined();
    credentials.discard({ ...key, sessionId: "other" });
    expect(credentials.peek(key)).toBe(services);
    credentials.discard(key);
    expect(credentials.size).toBe(0);
  });

  it("expires credentials without a later request and allows authenticated backlog replenishment", () => {
    vi.useFakeTimers();
    const credentials = createRuntimeJobCredentials({ defaultTtlMs: 10 });
    credentials.register(key, services);
    vi.advanceTimersByTime(11);
    expect(credentials.peek(key)).toBeUndefined();
    const replacement = { llm: {} as LLMAdapter };
    credentials.provide([key], replacement);
    expect(credentials.take(key)).toBe(replacement);
  });

  it("clears just the deleted session and releases all entries on shutdown", () => {
    const credentials = createRuntimeJobCredentials();
    credentials.register(key, services);
    const other = { ...key, jobId: "other", sessionId: "other-session" };
    credentials.register(other, services);
    credentials.clearSession(key.sessionId);
    expect(credentials.peek(key)).toBeUndefined();
    expect(credentials.peek(other)).toBe(services);
    credentials.clear();
    expect(credentials.size).toBe(0);
  });
});

describe("job credential hand-off", () => {
  const queued = (jobId: string, maxQueueMs?: number) => ({
    job: maxQueueMs === undefined ? {} : { maxQueueMs },
    credentialKey: { ...key, jobId },
  });

  it("registers for each job's queue time and withdraws all but the kept jobs", () => {
    vi.useFakeTimers();
    const credentials = createRuntimeJobCredentials({ defaultTtlMs: 100 });
    const handoff = createJobCredentialHandoff(credentials, () => services);
    handoff.register(queued("stage", 10));
    handoff.register(queued("kept"));
    handoff.handOff([queued("follower")]);
    // Only jobs registered inside a transaction are tracked for withdrawal.
    expect(handoff.keys.map(({ jobId }) => jobId)).toEqual(["stage", "kept"]);
    vi.advanceTimersByTime(11);
    expect(credentials.peek({ ...key, jobId: "stage" })).toBeUndefined();
    expect(credentials.peek({ ...key, jobId: "kept" })).toBe(services);

    handoff.discard(new Set(["kept"]));
    expect(credentials.peek({ ...key, jobId: "kept" })).toBe(services);
    expect(credentials.peek({ ...key, jobId: "follower" })).toBe(services);
    expect(handoff.keys.map(({ jobId }) => jobId)).toEqual(["kept"]);
    handoff.discard();
    expect(credentials.peek({ ...key, jobId: "kept" })).toBeUndefined();
    expect(handoff.keys).toEqual([]);
  });

  it("hands nothing over without services or a credential store", () => {
    const credentials = createRuntimeJobCredentials();
    const withoutServices = createJobCredentialHandoff(
      credentials,
      () => undefined,
    );
    withoutServices.register(queued("stage"));
    withoutServices.handOff([queued("follower")]);
    expect(withoutServices.keys).toEqual([]);
    expect(credentials.size).toBe(0);

    const withoutStore = createJobCredentialHandoff(undefined, () => services);
    withoutStore.register(queued("stage"));
    expect(withoutStore.keys).toEqual([]);
  });
});
