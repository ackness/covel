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
  getPluginNamespaceSnapshot,
  loadPluginData,
  resetPluginData,
  setActiveSession,
  usePluginData,
  usePluginNamespace,
  __clearAllPluginDataForTest,
} from "../plugin-data-store.js";

beforeEach(() => {
  __clearAllPluginDataForTest();
});

describe("plugin-data-store — sessionId-scoped isolation", () => {
  it("writes are contained to the active session's slot", () => {
    setActiveSession("session-a");
    applyChanges("core-codex", [
      { namespace: "message", key: "key-A", value: "from A", operation: "set" },
    ]);
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      "key-A": "from A",
    });

    // Switch to session B — A's writes must not be visible.
    setActiveSession("session-b");
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({});

    // B writes are isolated from A.
    applyChanges("core-codex", [
      { namespace: "message", key: "key-B", value: "from B", operation: "set" },
    ]);
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      "key-B": "from B",
    });

    // Switching back to A restores A's slot.
    setActiveSession("session-a");
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      "key-A": "from A",
    });
  });

  it("loadPluginData respects the active session binding", () => {
    setActiveSession("session-a");
    loadPluginData("core-codex", "message", [
      { key: "item-1", value: { name: "alpha" } },
      { key: "item-2", value: { name: "beta" } },
    ]);
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      "item-1": { name: "alpha" },
      "item-2": { name: "beta" },
    });

    setActiveSession("session-b");
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({});
  });

  it("resetPluginData clears only the active session's slot", () => {
    setActiveSession("session-a");
    applyChanges("core-codex", [
      { namespace: "message", key: "key-A", value: "A", operation: "set" },
    ]);

    setActiveSession("session-b");
    applyChanges("core-codex", [
      { namespace: "message", key: "key-B", value: "B", operation: "set" },
    ]);

    // Reset B while bound to B.
    resetPluginData();
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({});

    // A's slot must still be intact.
    setActiveSession("session-a");
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      "key-A": "A",
    });
  });

  it("writes are ignored when no session is bound (defensive)", () => {
    setActiveSession(null);
    applyChanges("core-codex", [
      { namespace: "message", key: "ignored", value: "noop", operation: "set" },
    ]);
    loadPluginData("core-codex", "message", [{ key: "also-ignored", value: 1 }]);
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({});
  });

  it("delete operation removes the key from the active session", () => {
    setActiveSession("session-a");
    applyChanges("core-codex", [
      { namespace: "message", key: "keep", value: "here", operation: "set" },
      { namespace: "message", key: "drop", value: "gone", operation: "set" },
    ]);
    applyChanges("core-codex", [
      { namespace: "message", key: "drop", value: null, operation: "delete" },
    ]);
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({
      keep: "here",
    });
  });

  it("reproduces Finding 8 A: stale plugin-data no longer leaks across session switches", () => {
    // Session 1 writes key-A (simulates core-codex populating message/key-A).
    setActiveSession("session-1");
    applyChanges("core-codex", [
      { namespace: "message", key: "key-A", value: "session 1 content", operation: "set" },
    ]);

    // User switches to session 2 (restoreSession flow now rebinds the store).
    setActiveSession("session-2");

    // Right-panel read in session 2 must NOT see key-A.
    expect(getPluginNamespaceSnapshot("core-codex", "message")).toEqual({});
  });
});

describe("plugin-data-store — React hook integration", () => {
  it("usePluginData re-renders when the active session changes", () => {
    setActiveSession("session-a");
    applyChanges("core-codex", [
      { namespace: "message", key: "k", value: "A", operation: "set" },
    ]);

    const { result } = renderHook(() => usePluginData());
    expect(result.current["core-codex"]?.message).toEqual({ k: "A" });

    act(() => {
      setActiveSession("session-b");
    });
    expect(result.current["core-codex"]?.message).toBeUndefined();
  });

  it("usePluginNamespace returns empty object on missing namespace", () => {
    setActiveSession("session-a");

    const { result } = renderHook(() =>
      usePluginNamespace("core-codex", "message"),
    );
    expect(result.current).toEqual({});

    act(() => {
      applyChanges("core-codex", [
        { namespace: "message", key: "x", value: 1, operation: "set" },
      ]);
    });
    expect(result.current).toEqual({ x: 1 });
  });

  it("usePluginNamespace re-renders on session switch", () => {
    setActiveSession("session-a");
    applyChanges("core-codex", [
      { namespace: "message", key: "x", value: "from A", operation: "set" },
    ]);

    const { result } = renderHook(() =>
      usePluginNamespace("core-codex", "message"),
    );
    expect(result.current).toEqual({ x: "from A" });

    act(() => {
      setActiveSession("session-b");
    });
    expect(result.current).toEqual({});

    act(() => {
      setActiveSession("session-a");
    });
    expect(result.current).toEqual({ x: "from A" });
  });
});
