/**
 * Acceptance scenarios 9 (partial) and 10 — MediaRef canonicalization &
 * job-status boundaries (docs 02 §2.1, §4.1; 04-migration §6 scenarios 9/10).
 *
 * These bodies live in a dedicated file (not inline in
 * scheduling-acceptance-contract.test.ts) to avoid an edit race with the agent
 * lighting scenario 15 in that file. The matching `it.todo`s there point here.
 *
 * Scenario 10 is proven by wiring the SAME `canonicalizeMediaRefs` into every
 * runtime-layer boundary (activation, same-execution binding, persistent export,
 * job data) against ONE shared MediaStore fixture, and asserting each boundary
 * reaches the same verdict: a ref the session cannot prove it holds is rejected,
 * and a good ref is accepted with its transient `url` stripped and its `size`
 * taken from the store. The fifth boundary — fork's atomic reference add and the
 * whole-fork failure on a missing asset — lives in the server route and is
 * covered in apps/server/tests/api/snapshot.test.ts.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store";
import type {
  JsonValue,
  RuntimeActivation,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { MediaStoreLike } from "../src/function-runtime/runtime-media-context.js";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../src/media/canonicalize-media-refs.js";
import { resolveInputBindings } from "../src/schedule/input-bindings.js";
import { publishExecutionExports } from "../src/commit/runtime-export-publish.js";
import {
  createProgressReporter,
  finalizeJobStatuses,
  type ProgressReporterDeps,
} from "../src/job-status/job-status.js";
import { normalizeHandlerResult } from "../src/commit/normalize-handler-result.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// ── Shared media fixture ──────────────────────────────────────────
// `goodId` exists and is referenced by OUR session; `otherId` exists but is
// owned by someone else (no ref row for OUR) — the ownership rejection case.
const OUR = "sess-mine";
const goodId = "a".repeat(64);
const otherId = "b".repeat(64);

function sharedMedia(): MediaOwnershipStore {
  return {
    async lookup(id) {
      return id === goodId || id === otherId
        ? { mime: "image/png", size: 100 }
        : null;
    },
    async isReferencedBy(id, sessionId) {
      return id === goodId && sessionId === OUR;
    },
  };
}

/** A good ref, optionally with a stale size / transient url to be canonicalized away. */
const goodRef = (extra?: Record<string, unknown>): JsonValue =>
  ({ id: goodId, mime: "image/png", size: 100, ...extra }) as JsonValue;
const badRef = (): JsonValue =>
  ({ id: otherId, mime: "image/png", size: 100 }) as JsonValue;
/** The canonical form every boundary should converge on for `goodRef`. */
const CANONICAL_GOOD = { id: goodId, mime: "image/png", size: 100 };

async function seedPlaying(store: ReturnType<typeof createMemoryStore>) {
  const now = new Date().toISOString();
  await store.createSession({
    id: OUR,
    worldId: "w",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

const succ = (runtimeId: string, output: unknown): RuntimeResult =>
  ({
    pluginId: runtimeId.split("/")[0]!,
    runtimeId,
    runId: `r-${runtimeId}`,
    turnId: "t",
    status: "success",
    output: output as RuntimeResult["output"],
    toolCalls: [],
    durationMs: 1,
    timestamp: new Date().toISOString(),
  }) as RuntimeResult;

describe("scenario 10: MediaRef canonicalization shared across boundaries", () => {
  it("activation boundary: rejects a non-referenced ref, canonicalizes a good one", async () => {
    const store = createMemoryStore();
    await seedPlaying(store);
    let seen: RuntimeActivation | undefined;
    const roller: RuntimeManifest = {
      name: "d/roller",
      pluginId: "d",
      description: "roller",
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "manual" },
      outputKind: "plugin",
      capabilities: [],
    } as RuntimeManifest;
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m): Promise<LoadedRuntime> => ({
        manifest: m,
        promptTemplate: "",
        handler: async (ctx) => {
          seen = ctx.activation;
          return {};
        },
      }),
      llm: new NoopLLM(),
      store,
      mediaStore: sharedMedia() as unknown as MediaStoreLike,
    };

    // Bad ref in the manual payload → activation fails.
    const bad = await executeTurn(
      {
        sessionId: OUR,
        turnId: "t1",
        playerMessage: "go",
        manualTrigger: { runtimeId: "d/roller", payload: { pic: badRef() } },
      },
      [roller],
      deps,
    );
    const badRR = bad.runtimeResults.find((r) => r.runtimeId === "d/roller");
    expect(badRR?.status).toBe("failed");
    expect(badRR?.error).toContain("media");

    // Good ref with stale size + transient url → success, canonical payload.
    const good = await executeTurn(
      {
        sessionId: OUR,
        turnId: "t2",
        playerMessage: "go",
        manualTrigger: {
          runtimeId: "d/roller",
          payload: { pic: goodRef({ size: 999, url: "https://x/y.png" }) },
        },
      },
      [roller],
      deps,
    );
    const goodRR = good.runtimeResults.find((r) => r.runtimeId === "d/roller");
    expect(goodRR?.status).toBe("success");
    expect(seen?.payload).toEqual({ pic: CANONICAL_GOOD });
  });

  it("binding boundary: required skip on a non-referenced ref, canonical slot on a good one", async () => {
    const media = sharedMedia();
    const canonicalizeValue = (value: JsonValue) =>
      canonicalizeMediaRefs(value, { store: media, sessionId: OUR });
    const producer: RuntimeManifest = {
      name: "p/gen",
      pluginId: "p",
      description: "gen",
      priority: 500,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
    } as RuntimeManifest;
    const consumer: RuntimeManifest = {
      name: "c/main",
      pluginId: "c",
      description: "consumer",
      priority: 600,
      runtimeType: "function",
      handler: "./h.js",
      trigger: { type: "auto" },
      outputKind: "plugin",
      capabilities: [],
      inputs: { data: { from: { runtime: "p/gen" }, required: true } },
    } as RuntimeManifest;
    const base = {
      manifest: consumer,
      activation: {
        source: "stage" as const,
        detached: false,
        payload: null,
      },
      activeRuntimes: [producer],
      acceptsSchemas: {},
      loadProducerSchema: async () => undefined,
      canonicalizeValue,
    };

    const bad = await resolveInputBindings({
      ...base,
      completedResults: new Map([["p/gen", succ("p/gen", { pic: badRef() })]]),
    });
    expect(bad).toMatchObject({
      ok: false,
      skipReason: "media-ownership-invalid",
    });

    const good = await resolveInputBindings({
      ...base,
      completedResults: new Map([
        [
          "p/gen",
          succ("p/gen", {
            pic: goodRef({ size: 999, url: "https://x/y.png" }),
          }),
        ],
      ]),
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.slots.data).toMatchObject({
        cardinality: "one",
        value: { pic: CANONICAL_GOOD },
      });
    }
  });

  it("export boundary: withholds a non-referenced ref, strips url from a persisted good one", async () => {
    const media = sharedMedia();
    const canonicalize = (value: JsonValue) =>
      canonicalizeMediaRefs(value, { store: media, sessionId: OUR });
    const appended: { value: unknown }[] = [];
    const sink = {
      getLatestRuntimeExport: async () => null,
      appendRuntimeExport: async (record: { value: unknown }) => {
        appended.push(record);
        return true;
      },
    };
    const decl = { recordAs: "track", pluginId: "p", pluginVersion: "1.0.0" };
    const args = (output: unknown) => ({
      sink,
      sessionId: OUR,
      results: [{ status: "success", runtimeId: "p/gen", runId: "r1", output }],
      declFor: () => decl,
      loadOutputSchema: async () => ({ type: "object" }),
      committedAt: new Date().toISOString(),
      canonicalize,
    });

    // Good ref → published with the transient url stripped.
    await publishExecutionExports(
      args({ audio: goodRef({ size: 999, url: "https://x/y.png" }) }),
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]!.value).toEqual({ audio: CANONICAL_GOOD });

    // Bad ref → export withheld (no revision appended), execution untouched.
    appended.length = 0;
    await publishExecutionExports(args({ audio: badRef() }));
    expect(appended).toHaveLength(0);
  });

  it("job-data boundary: throws on a non-referenced ref, canonicalizes a good one", async () => {
    const store = createMemoryStore();
    const deps: ProgressReporterDeps = {
      store,
      sessionId: OUR,
      progressScopeId: "exec-1",
      pluginId: "p",
      runtimeId: "p/worker",
      mediaStore: sharedMedia(),
    };
    const reporter = createProgressReporter(deps);

    await expect(
      reporter.report({
        jobId: "j",
        state: "progress",
        data: { pic: badRef() },
        sequence: 1,
      }),
    ).rejects.toThrow(/media/);

    await reporter.report({
      jobId: "j",
      state: "progress",
      data: { pic: goodRef({ size: 999, url: "https://x/y.png" }) },
      sequence: 2,
    });
    const rows = await store.listJobStatus(OUR, {
      progressScopeId: "exec-1",
      jobId: "j",
    });
    expect(rows[rows.length - 1]!.data).toEqual({ pic: CANONICAL_GOOD });
  });
});

describe("scenario 9: media pipeline & job-status boundaries", () => {
  it("progress reports queued/running, then the finalizer appends a terminal failed", async () => {
    const store = createMemoryStore();
    const deps: ProgressReporterDeps = {
      store,
      sessionId: OUR,
      progressScopeId: "exec-9",
      pluginId: "media-gen",
      runtimeId: "media-gen/worker",
    };
    const reporter = createProgressReporter(deps);
    // In-flight progress BEFORE the finalizer runs.
    await reporter.report({ jobId: "gen", state: "queued", sequence: 1 });
    await reporter.report({
      jobId: "gen",
      state: "running",
      progress: 0.5,
      sequence: 2,
    });
    // The execution failed → the still-open job is terminalised as failed.
    await finalizeJobStatuses(deps, {
      outcome: "failed",
      reportedJobs: ["gen"],
    });

    const rows = await store.listJobStatus(OUR, {
      progressScopeId: "exec-9",
      jobId: "gen",
    });
    expect(rows.map((r) => r.state)).toEqual(["queued", "running", "failed"]);
  });

  it("a non-success envelope keeps only jobStatus/diagnostics; domain writes are stripped", () => {
    const raw = {
      outcome: "failed",
      error: "provider down",
      effects: {
        jobStatus: [{ jobId: "g", state: "failed", sequence: 1 }],
        statePatches: [{ table: "s", field: "f", value: 1 }],
      },
    };
    const n = normalizeHandlerResult(raw, {
      resultFormat: "envelope-v1",
      runtimeType: "function",
    });
    expect(n.outcome.outcome).toBe("failed");
    const effects = (n.outcome as { effects?: Record<string, unknown> })
      .effects;
    expect(effects?.jobStatus).toBeDefined();
    expect(effects?.statePatches).toBeUndefined();
    expect(
      n.diagnostics.some(
        (d) => d.code === "non-success-domain-effects-stripped",
      ),
    ).toBe(true);
  });

  // TODO(compat projector): the legacy tracks/images view projection (Step 4/6
  // third-party-UI compat) is asserted when that projector lands.
});
