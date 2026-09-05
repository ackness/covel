import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary, WorldPluginPlan } from "@covel/shared";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import * as api from "@/services/api.js";
import { usePluginSelection } from "../use-plugin-selection.js";
import { usePrepRuntimeBindings } from "../use-prep-runtime-bindings.js";

vi.mock("@/services/api.js", () => ({
  getWorldPluginPlan: vi.fn(),
  getPrepRuntimeBindings: vi.fn(),
  setPrepRuntimeBindings: vi.fn(),
  updateSession: vi.fn(),
}));

const plugins: PluginSummary[] = ["core", "guide"].map((id) => ({
  id,
  displayName: id,
  description: "",
  pluginType: id === "core" ? "core-plugin" : "plugin",
  source: "builtin",
  status: "registered",
  runtimeCount: 1,
  capabilities: [],
  tags: [],
  runtimes: [
    {
      id,
      runtimeType: "agent",
      model: "text",
      trigger: { type: "auto" },
      execution: "sync",
      turnCompletion: { mode: "await" },
      outputKind: "plugin",
      capabilities: [],
      tags: [],
    },
  ],
  tools: [],
  userSettings: [],
}));

const plan: WorldPluginPlan = {
  worldId: "world-1",
  packs: [],
  policy: {
    preferredTags: [],
    avoidedTags: [],
    requiredCapabilities: [],
    requiredPluginIds: [],
    recommendedPluginIds: [],
    excludedPluginIds: [],
  },
  defaultPluginIds: ["core", "guide"],
};

const slots: ResolvedSlot[] = ["text", "custom"].map((slotId) => ({
  slotId,
  presetId: "",
  preset: null,
  label: slotId,
  tag: "text",
}));
const prepareWorldForServer = async () => {};

function deferredPlan() {
  let resolve!: (value: WorldPluginPlan) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorldPluginPlan>((resolveValue, rejectError) => {
    resolve = resolveValue;
    reject = rejectError;
  });
  return { promise, resolve, reject };
}

function usePrep(resolvedSlots: ResolvedSlot[]) {
  const selection = usePluginSelection(
    plan.worldId,
    plugins,
    prepareWorldForServer,
  );
  const ready =
    !selection.pluginPlanLoading &&
    selection.pluginPlanError === null &&
    selection.pluginPlan !== null;
  const { bindingState } = usePrepRuntimeBindings(
    plan.worldId,
    selection.selectedPluginSummaries,
    resolvedSlots,
    ready,
  );
  return { selection, bindingState, ready };
}

describe("prep runtime bindings with asynchronous plugin selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getPrepRuntimeBindings).mockReturnValue({ guide: "custom" });
  });

  it.each([false, true])(
    "preserves saved bindings until the plan and slots arrive (late slots: %s)",
    async (lateSlots) => {
      const pending = deferredPlan();
      vi.mocked(api.getWorldPluginPlan).mockReturnValue(pending.promise);
      const { result, rerender } = renderHook(
        ({ resolvedSlots }) => usePrep(resolvedSlots),
        { initialProps: { resolvedSlots: lateSlots ? [] : slots } },
      );

      await waitFor(() => expect(api.getWorldPluginPlan).toHaveBeenCalled());
      expect(result.current.ready).toBe(false);
      expect(result.current.bindingState.bindings).toEqual({ guide: "custom" });
      expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();

      await act(async () => pending.resolve(plan));
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.selection.selectedPluginIds).toContain("guide");
      expect(result.current.bindingState.bindings).toEqual({ guide: "custom" });
      expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();

      rerender({ resolvedSlots: slots });
      expect(result.current.bindingState.bindings).toEqual({ guide: "custom" });
      expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();
    },
  );

  it("preserves bindings across a failed plan and its retry", async () => {
    const first = deferredPlan();
    const retry = deferredPlan();
    vi.mocked(api.getWorldPluginPlan)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => usePrep(slots));

    await act(async () => first.reject(new Error("plan unavailable")));
    await waitFor(() =>
      expect(result.current.selection.pluginPlanError).toBe("plan unavailable"),
    );
    expect(result.current.ready).toBe(false);
    expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();

    act(() => result.current.selection.retryPluginPlan());
    await waitFor(() =>
      expect(api.getWorldPluginPlan).toHaveBeenCalledTimes(2),
    );
    expect(result.current.ready).toBe(false);
    expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();

    await act(async () => retry.resolve(plan));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.bindingState.bindings).toEqual({ guide: "custom" });
    expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();
  });

  it("waits for discovery and slots before assigning defaults", async () => {
    vi.mocked(api.getPrepRuntimeBindings).mockReturnValue({});
    const pending = deferredPlan();
    vi.mocked(api.getWorldPluginPlan).mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ resolvedSlots }) => usePrep(resolvedSlots),
      { initialProps: { resolvedSlots: [] as ResolvedSlot[] } },
    );

    act(() => result.current.bindingState.autoAssign());
    expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();
    await act(async () => pending.resolve(plan));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.setPrepRuntimeBindings).not.toHaveBeenCalled();

    rerender({ resolvedSlots: slots });
    await waitFor(() =>
      expect(api.setPrepRuntimeBindings).toHaveBeenCalledWith(plan.worldId, {
        core: "text",
        guide: "text",
      }),
    );
  });
});
