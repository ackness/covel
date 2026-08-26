import { describe, expect, it, vi } from "vitest";
import type { UISpecsResponse } from "@/services/api";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  listPluginData: vi.fn(),
}));
const pluginStore = vi.hoisted(() => ({
  loadPluginDataForSession: vi.fn(),
}));

vi.mock("@/services/api", () => api);
vi.mock("@/stores/plugin-data-store.js", () => pluginStore);

const { hydratePluginDataForUiSpecs } =
  await import("../plugin-data-hydration.js");

const specs = {
  right: [
    {
      pluginId: "fixture-plugin",
      specs: [{ dataSource: { namespace: "panel" } }],
    },
  ],
  message: [],
} as unknown as UISpecsResponse;

describe("plugin-data hydration session guard", () => {
  it("drops rows that finish after the originating session becomes stale", async () => {
    let releaseRows!: (rows: Array<{ key: string; value: unknown }>) => void;
    api.fetchUiSpecs.mockResolvedValue(specs);
    api.listPluginData.mockReturnValue(
      new Promise((resolve) => {
        releaseRows = resolve;
      }),
    );
    let current = true;
    const dispatch = vi.fn();

    const hydration = hydratePluginDataForUiSpecs(
      "sess-a",
      dispatch,
      () => current,
    );
    await Promise.resolve();
    current = false;
    releaseRows([{ key: "a", value: 1 }]);
    await hydration;

    expect(pluginStore.loadPluginDataForSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("writes current rows into the explicitly named session slot", async () => {
    api.fetchUiSpecs.mockResolvedValue(specs);
    api.listPluginData.mockResolvedValue([{ key: "a", value: 1 }]);
    const dispatch = vi.fn();

    await hydratePluginDataForUiSpecs("sess-a", dispatch, () => true);

    expect(pluginStore.loadPluginDataForSession).toHaveBeenCalledWith(
      "sess-a",
      "fixture-plugin",
      "panel",
      [{ key: "a", value: 1 }],
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PLUGIN_DATA_CHANGED" }),
    );
  });
});
