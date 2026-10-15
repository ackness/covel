import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPlugin } from "@covel/shared";
import i18n from "@/i18n";
import { DimensionProviderNotice } from "../dimension-provider-notice.js";

const plugin = (
  id: string,
  state: Partial<Pick<SessionPlugin, "active" | "approvalRequired">> = {},
): SessionPlugin => ({
  serverCodeApproved: true,
  sessionState: state.active === false ? "inactive" : "active",
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  id,
  displayName: id === "world-init" ? "World Init" : id,
  description: id,
  active: true,
  locked: false,
  hostState: "loaded",
  kind: "plugin",
  source: "builtin",
  runtimeCount: 0,
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
  provides: [],
  tags: [],
  ...state,
});

describe("DimensionProviderNotice", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });
  afterEach(cleanup);

  const notice = () => screen.queryByTestId("dimension-provider-paused");

  it("says the dimensions are paused while their plugin is gone", () => {
    render(
      <DimensionProviderNotice
        providerPluginId="world-init"
        plugins={[plugin("narrator")]}
      />,
    );
    expect(notice()?.textContent).toContain(
      "World dimensions are paused: world-init is not running",
    );
  });

  it("names an installed provider that does not run", () => {
    render(
      <DimensionProviderNotice
        providerPluginId="world-init"
        plugins={[plugin("world-init", { active: false })]}
      />,
    );
    expect(notice()?.textContent).toContain("World Init is not running");
  });

  it("stays away while the provider runs, waits for approval, or nothing is known", () => {
    const { rerender } = render(
      <DimensionProviderNotice
        providerPluginId="world-init"
        plugins={[plugin("world-init")]}
      />,
    );
    expect(notice()).toBeNull();
    rerender(
      <DimensionProviderNotice
        providerPluginId="world-init"
        plugins={[
          plugin("world-init", { active: false, approvalRequired: true }),
        ]}
      />,
    );
    expect(notice()).toBeNull();
    rerender(
      <DimensionProviderNotice providerPluginId="world-init" plugins={[]} />,
    );
    expect(notice()).toBeNull();
    rerender(
      <DimensionProviderNotice
        providerPluginId={undefined}
        plugins={[plugin("narrator")]}
      />,
    );
    expect(notice()).toBeNull();
  });
});
