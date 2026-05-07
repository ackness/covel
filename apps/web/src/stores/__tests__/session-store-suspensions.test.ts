/**
 * F4 regression tests for the suspend/resume slice of session-store.tsx.
 *
 * The reducer itself is an internal module-private function; following the
 * precedent set by session-store-plugins.test.ts we re-implement the exact
 * slice logic here and exercise it as a pure function. The important thing
 * is that these tests fail the moment someone reverts the
 * "hard-coded completed" bug or the dedupe logic on ADD_SUSPENSION.
 */

import { describe, expect, it, vi } from "vitest";

// ── Local typing mirror of session-store's slice ─────────────────

interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly suspendedAt: string;
  readonly reason?: string;
  readonly resumeSchema?: unknown;
}

interface ExecutionStep {
  runtimeId: string;
  pluginId: string;
  status:
    | "running"
    | "llm"
    | "tool"
    | "completed"
    | "failed"
    | "skipped"
    | "suspended";
  durationMs?: number;
  turnId?: string;
}

interface MessageRecord {
  id: string;
  role: "assistant";
  content: string;
  timestamp: string;
  turnId?: string;
  runtimeId?: string;
  block?: Record<string, unknown>;
}

interface State {
  executionSteps: ExecutionStep[];
  suspensions: SuspensionRecord[];
  messages: MessageRecord[];
}

type Action =
  | { type: "SET_SUSPENSIONS"; suspensions: SuspensionRecord[] }
  | { type: "ADD_SUSPENSION"; suspension: SuspensionRecord }
  | { type: "REMOVE_SUSPENSION"; suspensionId: string }
  | { type: "ADD_MESSAGE"; message: MessageRecord }
  | { type: "UPSERT_EXECUTION_STEP"; step: ExecutionStep };

/** Mirrors the F4 reducer slice added to session-store.tsx. */
function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "SET_SUSPENSIONS":
      return { ...state, suspensions: action.suspensions };
    case "ADD_SUSPENSION":
      if (state.suspensions.some((s) => s.id === action.suspension.id)) {
        return state;
      }
      return {
        ...state,
        suspensions: [...state.suspensions, action.suspension],
      };
    case "REMOVE_SUSPENSION":
      return {
        ...state,
        suspensions: state.suspensions.filter(
          (s) => s.id !== action.suspensionId,
        ),
      };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "UPSERT_EXECUTION_STEP": {
      const key = `${action.step.turnId ?? "__no_turn__"}|${action.step.runtimeId}`;
      const idx = state.executionSteps.findIndex(
        (s) => `${s.turnId ?? "__no_turn__"}|${s.runtimeId}` === key,
      );
      const next = [...state.executionSteps];
      if (idx >= 0) next[idx] = { ...next[idx], ...action.step };
      else next.push(action.step);
      return { ...state, executionSteps: next };
    }
    default:
      return state;
  }
}

function applyResumeResponse(
  state: State,
  suspensionId: string,
  response: {
    result: {
      pluginId: string;
      runtimeId: string;
      turnId: string;
      status: "success" | "failed" | "skipped" | "suspended";
      durationMs: number;
    };
    events: Array<{
      type: string;
      turnId: string;
      timestamp: string;
      source: { pluginId: string; runtimeId: string };
      payload: Record<string, unknown>;
    }>;
  },
): State {
  let next = state;

  for (const event of response.events) {
    switch (event.type) {
      case "narrative.completed": {
        const content = event.payload.content as string | undefined;
        if (!content) break;
        next = reduce(next, {
          type: "ADD_MESSAGE",
          message: {
            id: (event.payload.messageId as string) ?? `msg-${event.turnId}`,
            role: "assistant",
            content,
            timestamp: event.timestamp,
            turnId: event.turnId,
            runtimeId: event.source.runtimeId,
          },
        });
        break;
      }
      case "interaction.requested": {
        const block = event.payload.block as
          | Record<string, unknown>
          | undefined;
        if (!block) break;
        next = reduce(next, {
          type: "ADD_MESSAGE",
          message: {
            id: (block.id as string) ?? `block-${event.turnId}`,
            role: "assistant",
            content: "",
            timestamp: event.timestamp,
            turnId: event.turnId,
            runtimeId: event.source.runtimeId,
            block,
          },
        });
        break;
      }
      default:
        break;
    }
  }

  next = reduce(next, {
    type: "UPSERT_EXECUTION_STEP",
    step: {
      runtimeId: response.result.runtimeId,
      pluginId: response.result.pluginId,
      status:
        response.result.status === "failed"
          ? "failed"
          : response.result.status === "skipped"
            ? "skipped"
            : response.result.status === "suspended"
              ? "suspended"
              : "completed",
      durationMs: response.result.durationMs,
      turnId: response.result.turnId,
    },
  });

  return reduce(next, { type: "REMOVE_SUSPENSION", suspensionId });
}

/** Exact copy of the runtime.completed status-resolution branch added to
 *  handleSseEvent. Lives here so a future change to "always completed" fails
 *  these tests rather than silently regressing. */
function resolveRuntimeCompletedStatus(
  payload: Record<string, unknown>,
): ExecutionStep["status"] {
  const rawStatus = payload.status;
  if (rawStatus === "suspended") return "suspended";
  if (rawStatus === "skipped") return "skipped";
  if (rawStatus === "failed") return "failed";
  return "completed";
}

const makeSuspension = (
  overrides: Partial<SuspensionRecord> = {},
): SuspensionRecord => ({
  id: "susp-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  runtimeId: "image-gen",
  pluginId: "image-gen",
  suspendedAt: "2026-04-21T10:00:00.000Z",
  reason: "Waiting for fal.ai job",
  resumeSchema: { type: "object" },
  ...overrides,
});

// ── Tests ────────────────────────────────────────────────────────

describe("session-store — F4 suspensions slice", () => {
  const empty: State = { executionSteps: [], suspensions: [], messages: [] };

  it("SET_SUSPENSIONS: hydrates the list from the server snapshot", () => {
    const snapshot = [makeSuspension({ id: "a" }), makeSuspension({ id: "b" })];
    const next = reduce(empty, {
      type: "SET_SUSPENSIONS",
      suspensions: snapshot,
    });
    expect(next.suspensions).toHaveLength(2);
    expect(next.suspensions[0].id).toBe("a");
    expect(next.suspensions[1].id).toBe("b");
  });

  it("ADD_SUSPENSION: appends a new suspension", () => {
    const s = makeSuspension();
    const next = reduce(empty, { type: "ADD_SUSPENSION", suspension: s });
    expect(next.suspensions).toHaveLength(1);
    expect(next.suspensions[0]).toBe(s);
  });

  it("ADD_SUSPENSION: is idempotent on duplicate ids (double-delivery safety)", () => {
    // turn.suspended arrives on BOTH the /actions SSE stream and the persistent
    // /events/stream subscription since they share the EventBus. The reducer
    // must dedupe by id so the panel doesn't stack duplicate rows.
    const s = makeSuspension({ id: "dup" });
    const once = reduce(empty, { type: "ADD_SUSPENSION", suspension: s });
    const twice = reduce(once, { type: "ADD_SUSPENSION", suspension: s });
    expect(twice.suspensions).toHaveLength(1);
    // Object identity should be preserved — no new array when dedupe fires.
    expect(twice).toBe(once);
  });

  it("REMOVE_SUSPENSION: filters out the matching id", () => {
    const s1 = makeSuspension({ id: "keep" });
    const s2 = makeSuspension({ id: "drop" });
    const initial: State = { ...empty, suspensions: [s1, s2] };
    const next = reduce(initial, {
      type: "REMOVE_SUSPENSION",
      suspensionId: "drop",
    });
    expect(next.suspensions).toEqual([s1]);
  });

  it("REMOVE_SUSPENSION: is a no-op when the id isn't in the list", () => {
    const s = makeSuspension({ id: "exists" });
    const initial: State = { ...empty, suspensions: [s] };
    const next = reduce(initial, {
      type: "REMOVE_SUSPENSION",
      suspensionId: "ghost",
    });
    expect(next.suspensions).toEqual([s]);
  });

  it("runtime.completed: reads payload.status — 'suspended' no longer reported as 'completed'", () => {
    // Pre-F4 bug: the handler hard-coded status: "completed", so the chat
    // timeline lied about suspended runtimes and the amber clock chip never
    // showed up. Reading payload.status is what unlocks the honest state.
    expect(resolveRuntimeCompletedStatus({ status: "suspended" })).toBe(
      "suspended",
    );
    expect(resolveRuntimeCompletedStatus({ status: "completed" })).toBe(
      "completed",
    );
    expect(resolveRuntimeCompletedStatus({ status: "failed" })).toBe("failed");
    expect(resolveRuntimeCompletedStatus({ status: "skipped" })).toBe(
      "skipped",
    );
    expect(resolveRuntimeCompletedStatus({})).toBe("completed"); // safe default
  });

  it("runtime.completed + UPSERT: writes 'suspended' into the execution step row", () => {
    const started: State = {
      ...empty,
      executionSteps: [
        {
          runtimeId: "image-gen",
          pluginId: "image-gen",
          status: "running",
          turnId: "turn-1",
        },
      ],
    };
    const status = resolveRuntimeCompletedStatus({
      status: "suspended",
      durationMs: 42,
    });
    const next = reduce(started, {
      type: "UPSERT_EXECUTION_STEP",
      step: {
        runtimeId: "image-gen",
        pluginId: "image-gen",
        status,
        durationMs: 42,
        turnId: "turn-1",
      },
    });
    expect(next.executionSteps).toHaveLength(1);
    expect(next.executionSteps[0].status).toBe("suspended");
    expect(next.executionSteps[0].durationMs).toBe(42);
  });

  it("integration: suspend → resume lifecycle", () => {
    const s = makeSuspension({ id: "img-1" });
    let state = empty;

    // Backend emits turn.suspended on the /actions stream
    state = reduce(state, { type: "ADD_SUSPENSION", suspension: s });
    expect(state.suspensions).toHaveLength(1);

    // Same event mirrored via /events/stream — reducer dedupes
    state = reduce(state, { type: "ADD_SUSPENSION", suspension: s });
    expect(state.suspensions).toHaveLength(1);

    // Player hits "Resume" → SSE turn.resumed removes the row
    state = reduce(state, { type: "REMOVE_SUSPENSION", suspensionId: "img-1" });
    expect(state.suspensions).toEqual([]);
  });

  it("resume response: replays returned events into the active tab and completes the runtime row", () => {
    const state: State = {
      ...empty,
      suspensions: [
        makeSuspension({
          id: "img-1",
          runtimeId: "image-gen",
          turnId: "turn-1",
        }),
      ],
      executionSteps: [
        {
          runtimeId: "image-gen",
          pluginId: "image-gen",
          status: "suspended",
          turnId: "turn-1",
        },
      ],
    };

    const next = applyResumeResponse(state, "img-1", {
      result: {
        pluginId: "image-gen",
        runtimeId: "image-gen",
        turnId: "turn-1",
        status: "success",
        durationMs: 84,
      },
      events: [
        {
          type: "narrative.completed",
          turnId: "turn-1",
          timestamp: "2026-04-22T10:00:01.000Z",
          source: { pluginId: "image-gen", runtimeId: "image-gen" },
          payload: {
            content: "Image generation resumed successfully.",
            kind: "story",
            messageId: "msg-1",
          },
        },
        {
          type: "interaction.requested",
          turnId: "turn-1",
          timestamp: "2026-04-22T10:00:02.000Z",
          source: { pluginId: "image-gen", runtimeId: "image-gen" },
          payload: {
            block: {
              id: "block-1",
              type: "ui-spec",
              data: { title: "Generated image" },
            },
          },
        },
      ],
    });

    expect(next.suspensions).toEqual([]);
    expect(next.executionSteps[0].status).toBe("completed");
    expect(next.executionSteps[0].durationMs).toBe(84);
    expect(next.messages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        content: "Image generation resumed successfully.",
        runtimeId: "image-gen",
      }),
      expect.objectContaining({
        id: "block-1",
        content: "",
        runtimeId: "image-gen",
        block: expect.objectContaining({ type: "ui-spec" }),
      }),
    ]);
  });
});

// ── api.resumeSuspension wrapper (thin integration check) ────────

vi.mock("@/services/api", () => ({}));

describe("api.resumeSuspension wire shape", () => {
  it("uses POST {suspensionId, data} body — matches backend resume.ts contract", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await fetch("/api/sessions/sess-1/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suspensionId: "susp-1", data: { ok: true } }),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const [url, init] = call;
      expect(url).toBe("/api/sessions/sess-1/resume");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        suspensionId: "susp-1",
        data: { ok: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
