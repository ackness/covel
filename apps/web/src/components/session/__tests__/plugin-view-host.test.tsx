import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginViewHost } from "../plugin-view-host.js";
import { projection, viewEntry } from "./plugin-view-fixtures.js";
import i18n from "@/i18n/index.js";
const mocks = vi.hoisted(() => ({ panel: vi.fn(), throws: false }));
vi.mock("../use-session-bridge.js", () => ({
  useSessionBridge: () => ({
    projection,
    stream: { subscribe: () => () => {}, read: () => null },
  }),
}));
vi.mock("../plugin-panel.js", () => ({
  PluginPanel: (props: unknown) => {
    mocks.panel(props);
    if (mocks.throws) throw new Error("bad view");
    return <div>Plugin content</div>;
  },
}));
afterEach(() => {
  cleanup();
  mocks.panel.mockClear();
  mocks.throws = false;
  vi.restoreAllMocks();
});
it("draws the host bar outside the plugin container and gates session access", () => {
  const onFallback = vi.fn();
  const view = render(
    <PluginViewHost entry={viewEntry} sessionId="s" onFallback={onFallback} />,
  );
  expect(screen.getByText(i18n.t("session.viewReadsStory"))).toBeTruthy();
  expect(mocks.panel).not.toHaveBeenCalled();
  view.rerender(
    <PluginViewHost
      entry={viewEntry}
      sessionId="s"
      onFallback={onFallback}
      sessionBridgeAllowed
    />,
  );
  const bar = screen.getByTestId("plugin-view-bar");
  const container = screen.getByTestId("plugin-view-container");
  expect(bar.contains(container)).toBe(false);
  expect(container.contains(bar)).toBe(false);
  expect(bar.nextElementSibling).toBe(container);
  expect(mocks.panel.mock.lastCall?.[0]).toMatchObject({
    sessionBridge: { projection },
    fill: true,
    expanded: true,
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.backToDefaultView") }),
  );
  expect(onFallback).toHaveBeenCalled();
});
it("omits the notice and the projection for a view without a bridge", () => {
  render(
    <PluginViewHost
      entry={{ ...viewEntry, spec: { ...viewEntry.spec, bridge: undefined } }}
      sessionId="s"
      onFallback={vi.fn()}
    />,
  );
  expect(screen.queryByText(i18n.t("session.viewReadsStory"))).toBeNull();
  expect(mocks.panel.mock.lastCall?.[0]).toHaveProperty(
    "sessionBridge",
    undefined,
  );
});
it("falls back on a child error while keeping the host back button", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.throws = true;
  const fallback = vi.fn();
  render(
    <PluginViewHost
      entry={viewEntry}
      sessionId="s"
      onFallback={fallback}
      sessionBridgeAllowed
    />,
  );
  expect(fallback).toHaveBeenCalledWith("render-error");
  expect(
    screen.getByRole("button", { name: i18n.t("session.backToDefaultView") }),
  ).toBeTruthy();
});
it("offers consent revocation in the host view menu", () => {
  const revoke = vi.fn();
  render(
    <PluginViewHost
      entry={viewEntry}
      sessionId="s"
      onFallback={vi.fn()}
      onRevoke={revoke}
      sessionBridgeAllowed
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.viewPermissions") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("session.revokeViewConsent") }),
  );
  expect(revoke).toHaveBeenCalledOnce();
});
