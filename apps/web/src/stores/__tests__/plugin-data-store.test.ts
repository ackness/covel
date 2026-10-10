/**
 * Tests for plugin-data-store — sessionId-scoped in-memory cache backing
 * the right-panel json-render surfaces (findings/08-frontend-races.md A).
 *
 * Verifies:
 *   1. Store is keyed by sessionId, so switching sessions auto-isolates.
 *   2. `resetPluginData` wipes only the active session's slot.
 *   3. Leaving the store unbound (`null`) returns an empty snapshot even
 *      though a previous session's data is still retained internally.
 *   4. Hooks re-render via useSyncExternalStore on apply / load / reset
 *      / setActiveSession transitions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  applyChanges,
  backgroundJobRecord,
  dropPluginDataSession,
  getPluginNamespacesSnapshot,
  getPluginNamespaceSnapshot,
  loadPluginData,
  resetPluginData,
  loadPluginDataForSession,
  replacePluginDataForSession,
  setActiveSession,
  usePluginData,
  usePluginNamespaces,
  usePluginNamespace,
  __clearAllPluginDataForTest,
} from "../plugin-data-store.js";

beforeEach(() => {
  __clearAllPluginDataForTest();
});

describe("plugin-data-store — sessionId-scoped isolation", () => {
  it("writes are contained to the active session's slot", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "key-A", value: "from A", operation: "set" },
    ]);
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({
      "key-A": "from A",
    });

    // Switch to session B — A's writes must not be visible.
    setActiveSession("session-b");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});

    // B writes are isolated from A.
    applyChanges("codex", [
      { namespace: "message", key: "key-B", value: "from B", operation: "set" },
    ]);
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({
      "key-B": "from B",
    });

    // A's slot was evicted on leaving; returning starts empty until refetched.
    setActiveSession("session-a");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });

  it("loadPluginData respects the active session binding", () => {
    setActiveSession("session-a");
    loadPluginData("codex", "message", [
      { key: "item-1", value: { name: "alpha" } },
      { key: "item-2", value: { name: "beta" } },
    ]);
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({
      "item-1": { name: "alpha" },
      "item-2": { name: "beta" },
    });

    setActiveSession("session-b");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });

  it("resetPluginData clears only the active session's slot", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "key-A", value: "A", operation: "set" },
    ]);

    setActiveSession("session-b");
    applyChanges("codex", [
      { namespace: "message", key: "key-B", value: "B", operation: "set" },
    ]);

    // Reset B while bound to B.
    resetPluginData();
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});

    // A was evicted when B became active.
    setActiveSession("session-a");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });

  it("drops a deleted session while preserving the newly active session", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "old", value: "A", operation: "set" },
    ]);
    setActiveSession("session-b");
    applyChanges("codex", [
      { namespace: "message", key: "current", value: "B", operation: "set" },
    ]);

    dropPluginDataSession("session-a");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({
      current: "B",
    });
    setActiveSession("session-a");
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });

  it("writes are ignored when no session is bound (defensive)", () => {
    setActiveSession(null);
    applyChanges("codex", [
      { namespace: "message", key: "ignored", value: "noop", operation: "set" },
    ]);
    loadPluginData("codex", "message", [{ key: "also-ignored", value: 1 }]);
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });

  it("delete operation removes the key from the active session", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "keep", value: "here", operation: "set" },
      { namespace: "message", key: "drop", value: "gone", operation: "set" },
    ]);
    applyChanges("codex", [
      { namespace: "message", key: "drop", value: null, operation: "delete" },
    ]);
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({
      keep: "here",
    });
  });

  it("reproduces Finding 8 A: stale plugin-data no longer leaks across session switches", () => {
    // Session 1 writes key-A (simulates codex populating message/key-A).
    setActiveSession("session-1");
    applyChanges("codex", [
      {
        namespace: "message",
        key: "key-A",
        value: "session 1 content",
        operation: "set",
      },
    ]);

    // User switches to session 2 (restoreSession flow now rebinds the store).
    setActiveSession("session-2");

    // Right-panel read in session 2 must NOT see key-A.
    expect(getPluginNamespaceSnapshot("codex", "message")).toEqual({});
  });
});

describe("plugin-data-store — React hook integration", () => {
  it("keeps the owner snapshot stable when another plugin writes", () => {
    setActiveSession("session-a");
    const { result } = renderHook(() => usePluginNamespaces("owner"));
    const empty = result.current;
    expect(getPluginNamespacesSnapshot("owner")).toBe(empty);
    act(() => {
      applyChanges("other", [
        { namespace: "private", key: "x", value: 1, operation: "set" },
      ]);
    });
    expect(result.current).toBe(empty);
    act(() => {
      applyChanges("owner", [
        {
          namespace: "nodes",
          key: "a",
          value: { name: "A" },
          operation: "set",
        },
      ]);
    });
    expect(result.current).not.toBe(empty);
    expect(result.current.nodes).toEqual({ a: { name: "A" } });
    act(() => setActiveSession("session-b"));
    expect(result.current).toBe(empty);
  });

  it("usePluginData re-renders when the active session changes", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "k", value: "A", operation: "set" },
    ]);

    const { result } = renderHook(() => usePluginData());
    expect(result.current["codex"]?.message).toEqual({ k: "A" });

    act(() => {
      setActiveSession("session-b");
    });
    expect(result.current["codex"]?.message).toBeUndefined();
  });

  it("usePluginNamespace returns empty object on missing namespace", () => {
    setActiveSession("session-a");

    const { result } = renderHook(() => usePluginNamespace("codex", "message"));
    expect(result.current).toEqual({});

    act(() => {
      applyChanges("codex", [
        { namespace: "message", key: "x", value: 1, operation: "set" },
      ]);
    });
    expect(result.current).toEqual({ x: 1 });
  });

  it("usePluginNamespace re-renders on session switch", () => {
    setActiveSession("session-a");
    applyChanges("codex", [
      { namespace: "message", key: "x", value: "from A", operation: "set" },
    ]);

    const { result } = renderHook(() => usePluginNamespace("codex", "message"));
    expect(result.current).toEqual({ x: "from A" });

    act(() => {
      setActiveSession("session-b");
    });
    expect(result.current).toEqual({});

    act(() => {
      setActiveSession("session-a");
    });
    expect(result.current).toEqual({});
  });
});

it("replaces all namespaces only for the requested active-session plugin", () => {
  setActiveSession("session-a");
  loadPluginData("provider", "removed", [{ key: "stale", value: true }]);
  loadPluginData("other", "message", [{ key: "kept", value: true }]);
  expect(
    replacePluginDataForSession("session-a", "provider", {
      current: { value: "fresh" },
    }),
  ).toBe(true);
  expect(getPluginNamespaceSnapshot("provider", "removed")).toEqual({});
  expect(getPluginNamespaceSnapshot("provider", "current")).toEqual({
    value: "fresh",
  });
  expect(getPluginNamespaceSnapshot("other", "message")).toEqual({
    kept: true,
  });
  expect(replacePluginDataForSession("session-a", "provider", {})).toBe(true);
  expect(getPluginNamespaceSnapshot("provider", "current")).toEqual({});
});

it("rejects a late plugin replacement or deletion for another active session", () => {
  setActiveSession("session-a");
  loadPluginData("provider", "message", [{ key: "value", value: "a" }]);
  setActiveSession("session-b");
  loadPluginData("provider", "message", [{ key: "value", value: "b" }]);
  expect(replacePluginDataForSession("session-a", "provider", {})).toBe(false);
  expect(getPluginNamespaceSnapshot("provider", "message")).toEqual({
    value: "b",
  });
  setActiveSession("session-a");
  expect(getPluginNamespaceSnapshot("provider", "message")).toEqual({});
});

it("ignores a late load for a session that was left, so it cannot repopulate the cache", () => {
  setActiveSession("session-a");
  setActiveSession("session-b");
  loadPluginDataForSession("session-a", "provider", "message", [
    { key: "late", value: 1 },
  ]);
  setActiveSession("session-a");
  expect(getPluginNamespaceSnapshot("provider", "message")).toEqual({});
});

it("treats inherited plugin and namespace names as missing until explicitly loaded", () => {
  setActiveSession("session-a");
  const empty = getPluginNamespacesSnapshot("missing");
  expect(getPluginNamespacesSnapshot("constructor")).toBe(empty);
  expect(getPluginNamespaceSnapshot("constructor", "constructor")).toEqual({});
  loadPluginData("constructor", "constructor", [
    { key: "value", value: "owned" },
  ]);
  expect(getPluginNamespacesSnapshot("constructor")).toEqual({
    constructor: { value: "owned" },
  });
  expect(getPluginNamespaceSnapshot("constructor", "constructor")).toEqual({
    value: "owned",
  });
  expect(getPluginNamespaceSnapshot("constructor", "toString")).toEqual({});
});

describe("backgroundJobRecord", () => {
  const row = (overrides: Record<string, unknown>) => ({
    runtimeId: "image/render",
    origin: { activation: "manual", sourceTurnId: "rpc-turn" },
    enqueuedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  });

  it("covers background activations only, not detached stages", () => {
    expect(
      backgroundJobRecord(
        "stage-job",
        row({ status: "running", origin: { activation: "stage" } }),
      ),
    ).toBeNull();
    expect(backgroundJobRecord("job", row({ status: "claimed" }))).toEqual({
      jobId: "job",
      status: "pending",
      runtimeId: "image/render",
      startedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("reports the runtime's own error before the generic job error", () => {
    expect(
      backgroundJobRecord(
        "job",
        row({
          status: "failed",
          error: "Runtime job execution failed.",
          finishedAt: "2026-10-02T00:01:00.000Z",
          result: {
            turnId: "background-turn",
            durationMs: 42,
            runtimeResults: [
              {
                runtimeId: "image/render",
                status: "success",
                output: { status: "failed", error: "quota exceeded" },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: "quota exceeded",
      turnId: "background-turn",
      completedAt: "2026-10-02T00:01:00.000Z",
      durationMs: 42,
    });
    expect(
      backgroundJobRecord("job", row({ status: "timed_out", error: "late" })),
    ).toMatchObject({ status: "failed", error: "late" });
    expect(
      backgroundJobRecord("job", row({ status: "succeeded" }))?.status,
    ).toBe("done");
  });

  it("describes a prompt-builder job by its phase", () => {
    expect(
      backgroundJobRecord("job", row({ status: "running", phase: "prompt" })),
    ).toMatchObject({ messageKey: "pluginRpc.jobs.imagePromptGenerating" });
    expect(
      backgroundJobRecord(
        "job",
        row({
          status: "succeeded",
          phase: "prompt",
          result: { deferredJobs: [{ jobId: "f", runtimeId: "image/render" }] },
        }),
      ),
    ).toMatchObject({ messageKey: "pluginRpc.jobs.imagePromptQueued" });
    expect(
      backgroundJobRecord("job", row({ status: "failed", phase: "prompt" })),
    ).not.toHaveProperty("messageKey");
    expect(
      backgroundJobRecord("job", row({ status: "running" })),
    ).not.toHaveProperty("messageKey");
  });
});
