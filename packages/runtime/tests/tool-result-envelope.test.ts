import { createMemoryStore } from "@covel/store/memory";
import { createPluginDataVisibility } from "../src/function-runtime/upstream-plugin-data.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApprovalPipeline } from "@covel/approval";
import {
  ToolError,
  createPluginDataTools,
  tool,
  withModelView,
  withPendingProposals,
  withEmittedEvents,
} from "@covel/tools";
import type { Proposal } from "@covel/shared";
import {
  createToolExecutor,
  type ToolCallContext,
  type ToolExecutorConfig,
} from "../src/agent-loop/tool-executor.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const ctx: ToolCallContext = {
  sessionId: "s",
  turnId: "t",
  pluginId: "p",
  runtimeId: "p/r",
  locale: "en",
};
const call = { toolCallId: "c", name: "probe", arguments: "{}" };
const proposal: Proposal = {
  id: "w",
  type: "plugin.data",
  source: { pluginId: "p", runtimeId: "p/r" },
  sessionId: "s",
  turnId: "t",
  timestamp: "2026-10-01T00:00:00Z",
  payload: { namespace: "notes", key: "k", value: 1 },
};
const event = { topic: "changed", data: {} };
const makeTool = (execute: () => Promise<unknown>, readOnly = false) =>
  tool({
    name: "probe",
    description: "Probe",
    parameters: z.object({}),
    annotations: { readOnly },
    execute,
  });
async function run(
  execute: () => Promise<unknown>,
  context = ctx,
  config: ToolExecutorConfig = {},
  readOnly = false,
) {
  const executor = createToolExecutor({
    findTool: () => makeTool(execute, readOnly),
    ...config,
  });
  try {
    return await executor.execute(call, context);
  } finally {
    await executor.close();
  }
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("tool result envelope", () => {
  it("projects plain content while preserving raw UI and bookkeeping for code", async () => {
    const raw = {
      a: 1,
      updatedAt: "2026-10-01T00:00:00Z",
      ui: [{ parts: [] }],
    };
    const result = await run(async () => raw);
    expect(JSON.parse(result.result)).toEqual({ data: { a: 1 } });
    expect(result.parsedResult).toEqual(raw);
  });
  it("renders explicit views exactly and projects only their data", async () => {
    expect(
      (await run(async () => withModelView({ secret: 1 }, { summary: "Hi" })))
        .result,
    ).toBe('{"summary":"Hi"}');
    expect(
      (
        await run(async () =>
          withModelView(
            { secret: 1 },
            {
              summary: "Hi",
              data: { turnId: "b85ce609-cc20-4563-a464-d8034ac0eacd", k: 1 },
            },
          ),
        )
      ).result,
    ).toBe('{"summary":"Hi","data":{"k":1}}');
    for (const result of [
      withModelView(withPendingProposals({}, [proposal]), { summary: "Hi" }),
      withPendingProposals(withModelView({}, { summary: "Hi" }), [proposal]),
    ]) {
      expect((await run(async () => result)).pendingProposals).toEqual([
        proposal,
      ]);
    }
  });
  it.each([
    [
      "en",
      undefined,
      "Staged: it takes effect when the turn ends and may still be rejected.",
    ],
    ["zh-CN", undefined, "已暂存，回合结束时生效（可能被拒绝）。"],
    ["en", "zh", "已暂存，回合结束时生效（可能被拒绝）。"],
  ])(
    "localizes staged effects for %s with override %s",
    async (locale, override, notice) => {
      if (override) vi.stubEnv("COVEL_INSTRUCTION_LOCALE", override);
      const result = await run(
        async () =>
          withEmittedEvents(
            withPendingProposals(
              withModelView({}, { summary: "Hi", data: { n: 1 } }),
              [proposal, { ...proposal, id: "w2" }],
            ),
            [event],
          ),
        { ...ctx, locale },
      );
      expect(JSON.parse(result.result)).toEqual({
        summary: "Hi",
        data: { n: 1 },
        staged: { count: 3, kinds: ["plugin.data", "event"], notice },
      });
      expect(Object.keys(JSON.parse(result.result))).toEqual([
        "summary",
        "data",
        "staged",
      ]);
      expect(
        JSON.parse((await run(async () => ({}), ctx, {}, true)).result),
      ).not.toHaveProperty("staged");
    },
  );
  it("uses a localized completion summary for an empty explicit view", async () => {
    expect(
      (
        await run(async () => withModelView({}, {}), {
          ...ctx,
          locale: "zh-CN",
        })
      ).result,
    ).toBe('{"summary":"完成。"}');
  });

  it.each([
    { path: "undeclared", code: "unavailable" },
    { path: "unknown", code: "not-found" },
    { path: "denied", code: "refused", hint: "Do not retry this call." },
    {
      path: "json",
      code: "invalid-input",
      hint: "Send the arguments as one JSON object.",
    },
    {
      path: "validation",
      code: "invalid-input",
      hint: "Fix these fields and call the tool again.",
    },
    { path: "timeout", code: "timeout" },
    { path: "abort", code: "cancelled" },
    { path: "coded", code: "ambiguous", hint: "h" },
    { path: "read-only", code: "internal" },
    { path: "unexpected", code: "internal" },
    { path: "refusal", code: "refused" },
  ])("returns a coded envelope for $path", async ({ path, code, hint }) => {
    const emitter = makeEmitterSpy();
    const controller = new AbortController();
    const rawMessage =
      "Private b85ce609-cc20-4563-a464-d8034ac0eacd\nSECOND-LINE-MARKER at hidden stack frame";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const command = tool({
      name: "probe",
      description: "Probe",
      parameters:
        path === "validation"
          ? z.object({ first: z.string(), second: z.number() })
          : z.object({}),
      ...(path === "timeout" ? { timeoutMs: 5 } : {}),
      annotations: { readOnly: path === "read-only" },
      execute: async () => {
        if (path === "timeout")
          return new Promise((resolve) => setTimeout(resolve, 20));
        if (path === "abort") {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (path === "coded")
          throw new ToolError("ambiguous", "m", { hint: "h" });
        if (path === "refusal") throw new ToolError("refused", "No work");
        if (path === "unexpected") throw new Error(rawMessage);
        return withPendingProposals({}, [proposal]);
      },
    });
    const executor = createToolExecutor({
      findTool: () => (path === "unknown" ? undefined : command),
      ...(path === "denied"
        ? {
            approval: createApprovalPipeline([
              { pattern: "probe", action: "deny" },
            ]),
          }
        : {}),
    });
    try {
      const result = await executor.execute(
        { ...call, ...(path === "json" ? { arguments: "{" } : {}) },
        {
          ...ctx,
          emitter,
          signal: controller.signal,
          ...(path === "undeclared"
            ? { authorizedToolNames: new Set<string>() }
            : {}),
        },
      );
      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code,
        message: expect.any(String),
        ...(hint ? { hint } : {}),
      });
      expect(JSON.parse(result.result)).toEqual({ error: result.error });
      expect(result.parsedResult).toBeNull();
      if (path === "refusal") expect(result.refused).toBe(true);
      else expect(result).not.toHaveProperty("refused");
      const trace = emitter.events.find(
        (e) => e.type === "tool.failed",
      )?.payload;
      expect(trace).toMatchObject({ code, ...(hint ? { hint } : {}) });
      if (path === "validation") {
        expect(result.error?.message).toContain("first");
        expect(result.error?.message).toContain("second");
      }
      if (path === "coded")
        expect(result.error).toEqual({ code, message: "m", hint: "h" });
      if (path === "unexpected") {
        expect(result.error?.message).toBe('Tool "probe" failed: Private <id>');
        expect(result.result).not.toContain("SECOND-LINE-MARKER");
        expect(result.result).not.toContain("at hidden");
        expect(result.result).not.toContain("b85ce609");
        expect(trace?.error).toBe(rawMessage);
      }
    } finally {
      await executor.close();
    }
  });
  it("cuts a long first line of an unexpected failure to 300 characters", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = makeEmitterSpy();
    const rawMessage = "y".repeat(1000);
    const result = await run(
      async () => {
        throw new Error(rawMessage);
      },
      { ...ctx, emitter },
    );
    expect(result.error).toEqual({
      code: "internal",
      message: `Tool "probe" failed: ${"y".repeat(300)}`,
    });
    expect(
      emitter.events.find((e) => e.type === "tool.failed")?.payload.error,
    ).toBe(rawMessage);
  });
  it("bounds coded messages but retains their full trace", async () => {
    const emitter = makeEmitterSpy();
    const result = await run(
      async () => {
        throw new ToolError("conflict", "x".repeat(2100));
      },
      { ...ctx, emitter },
    );
    expect(result.error?.message).toHaveLength(2000);
    expect(
      emitter.events.find((e) => e.type === "tool.failed")?.payload.error,
    ).toHaveLength(2100);
  });
  it("conceals error text and hints before persisting", async () => {
    const store = { addTraceEvent: vi.fn(async () => {}) };
    const emitter = createTurnEmitter({
      store,
      sessionId: "s",
      turnId: "t",
      concealedRuntimeIds: new Set([ctx.runtimeId]),
    });
    await run(
      async () => {
        throw new ToolError("ambiguous", "secret", { hint: "secret hint" });
      },
      { ...ctx, emitter },
    );
    const record = store.addTraceEvent.mock.calls as unknown as [
      { payload: Record<string, unknown> },
    ][];
    const payload = record.find(
      ([r]) => r.payload.toolName === "probe" && r.payload.success === false,
    )?.[0].payload;
    expect(payload).toBeDefined();
    for (const key of ["code", "error", "hint", "result"])
      expect(payload).not.toHaveProperty(key);
  });
});

describe("scoped plugin-data timestamps through the executor", () => {
  it.each(["own", "upstream"] as const)(
    "preserves stored timestamps and omits pending-only timestamps for %s writes",
    async (source) => {
      const store = createMemoryStore();
      const stored = {
        id: "stored-row",
        sessionId: ctx.sessionId,
        pluginId: ctx.pluginId,
        namespace: "notes",
        key: "stored",
        value: { n: 0 },
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      };
      await store.setPluginData(stored);
      const modules = createPluginDataTools(store);
      const executor = createToolExecutor({
        store,
        findTool: (name) => modules.find((module) => module.name === name),
      });
      const pending: Proposal[] = [];
      try {
        for (const key of ["stored", "new"]) {
          const result = await executor.execute(
            {
              toolCallId: `set-${key}`,
              name: "plugin-data-set",
              arguments: JSON.stringify({
                namespace: "notes",
                key,
                value: { n: 1 },
              }),
            },
            source === "upstream" ? { ...ctx, runtimeId: "p/upstream" } : ctx,
          );
          expect(result.success, result.result).toBe(true);
          pending.push(...(result.pendingProposals ?? []));
        }
        expect(pending).toHaveLength(2);
        const context = {
          ...ctx,
          ...(source === "own"
            ? { pendingProposals: pending }
            : {
                pluginDataVisibility: createPluginDataVisibility({
                  pluginId: ctx.pluginId,
                  runtimeId: ctx.runtimeId,
                  writes: pending.map((proposal) => ({
                    runId: "upstream-run",
                    runtimeId: "p/upstream",
                    proposal,
                  })),
                }),
              }),
        };
        for (const key of ["stored", "new"]) {
          const result = await executor.execute(
            {
              toolCallId: `get-${key}`,
              name: "plugin-data-get",
              arguments: JSON.stringify({ namespace: "notes", key }),
            },
            context,
          );
          expect(result.success, result.result).toBe(true);
          expect(result.parsedResult).toEqual({
            found: true,
            namespace: "notes",
            key,
            value: { n: 1 },
            ...(key === "stored" ? { updatedAt: stored.updatedAt } : {}),
          });
          expect(JSON.parse(result.result).data).not.toHaveProperty(
            "updatedAt",
          );
        }
        for (const args of [{ namespace: "notes" }, {}]) {
          const result = await executor.execute(
            {
              toolCallId: "list",
              name: "plugin-data-list",
              arguments: JSON.stringify(args),
            },
            context,
          );
          expect(result.success, result.result).toBe(true);
          expect(result.parsedResult).toEqual({
            count: 2,
            items: [
              {
                namespace: "notes",
                key: "stored",
                value: { n: 1 },
                updatedAt: stored.updatedAt,
              },
              { namespace: "notes", key: "new", value: { n: 1 } },
            ],
          });
        }
        expect(
          await store.getPluginData(
            ctx.sessionId,
            ctx.pluginId,
            "notes",
            "new",
          ),
        ).toBeNull();
        expect(
          await store.getPluginData(
            ctx.sessionId,
            ctx.pluginId,
            "notes",
            "stored",
          ),
        ).toEqual(stored);
      } finally {
        await executor.close();
        await store.close();
      }
    },
  );
});
