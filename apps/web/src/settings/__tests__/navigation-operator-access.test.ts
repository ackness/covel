import { describe, expect, it } from "vitest";
import type { SettingsStoreApi } from "@covel/settings";
import {
  buildNavTree,
  filterNav,
  OPERATOR_ACCESS_NODE_ID,
} from "../navigation.js";

const emptyStore = {
  listEntries: () => [],
} as unknown as SettingsStoreApi;

describe("operator access settings navigation", () => {
  it("exposes the browser credential pane in every locale", () => {
    const english = buildNavTree(emptyStore, { locale: "en-US" });
    const chinese = buildNavTree(emptyStore, { locale: "zh-CN" });

    expect(
      english.find((node) => node.id === OPERATOR_ACCESS_NODE_ID)?.label,
    ).toBe("Operator Access");
    expect(
      chinese.find((node) => node.id === OPERATOR_ACCESS_NODE_ID)?.label,
    ).toBe("运维访问");
  });

  it("is discoverable through settings search", () => {
    const nodes = buildNavTree(emptyStore, { locale: "en-US" });

    expect(filterNav(nodes, "operator", "en-US")).toEqual([
      expect.objectContaining({ id: OPERATOR_ACCESS_NODE_ID }),
    ]);
  });
});
