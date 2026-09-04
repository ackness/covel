import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary, WorldPluginPlan } from "@covel/shared";
import { usePluginSelection } from "../use-plugin-selection.js";
import * as api from "@/services/api.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/services/api.js", () => ({
  getWorldPluginPlan: vi.fn(),
}));

const CORE_PLUGIN = {
  id: "core",
  pluginType: "core-plugin",
  source: "builtin",
  tags: [],
} as unknown as PluginSummary;

const PLAN: WorldPluginPlan = {
  worldId: "world-1",
  packs: [],
  policy: {
    preferredTags: [],
    avoidedTags: [],
    requiredCapabilities: [],
    requiredPluginIds: ["world-required"],
    recommendedPluginIds: [],
    excludedPluginIds: [],
  },
  defaultPluginIds: ["core", "world-required"],
};

describe("usePluginSelection", () => {
  beforeEach(() => {
    vi.mocked(api.getWorldPluginPlan).mockReset();
  });

  it("keeps a failed plugin plan explicit and retries it", async () => {
    vi.mocked(api.getWorldPluginPlan)
      .mockRejectedValueOnce(new Error("plan unavailable"))
      .mockResolvedValueOnce(PLAN);

    const prepareWorldForServer = vi.fn(async () => {});
    const { result } = renderHook(() =>
      usePluginSelection("world-1", [CORE_PLUGIN], prepareWorldForServer),
    );

    await waitFor(() => {
      expect(result.current.pluginPlanLoading).toBe(false);
      expect(result.current.pluginPlanError).toBe("plan unavailable");
    });
    expect(result.current.pluginPlan).toBeNull();

    act(() => result.current.retryPluginPlan());

    await waitFor(() => {
      expect(result.current.pluginPlan).toEqual(PLAN);
      expect(result.current.pluginPlanError).toBeNull();
      expect(result.current.pluginPlanLoading).toBe(false);
    });
    expect(api.getWorldPluginPlan).toHaveBeenCalledTimes(2);
    expect(api.getWorldPluginPlan).toHaveBeenCalledWith("world-1", {
      silentErrors: true,
    });
    expect(prepareWorldForServer).toHaveBeenCalledTimes(2);
  });
});
