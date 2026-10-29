import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginPanel } from "../plugin-panel.js";
import type { PluginWebview } from "../plugin-webview.js";
import { projection, viewEntry } from "./plugin-view-fixtures.js";
const captured = vi.hoisted(() => ({
  props: undefined as ComponentProps<typeof PluginWebview> | undefined,
}));
vi.mock("../plugin-webview.js", () => ({
  PluginWebview: (props: ComponentProps<typeof PluginWebview>) => {
    captured.props = props;
    return <div />;
  },
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { session: { id: "s" }, gameState: { characters: [] } },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));
afterEach(cleanup);
it("forwards session projection and stream only for an opted-in spec and fills the view", () => {
  const stream = { subscribe: () => () => {}, read: () => null };
  const spec = { ...viewEntry.spec };
  const values = {
    pluginId: "p",
    spec,
    fill: true,
    sessionBridge: { projection, stream },
    stateOverride: {},
  };
  const view = render(<PluginPanel {...values} />);
  expect(captured.props?.state.session).toEqual(projection);
  expect(captured.props?.stream).toBe(stream);
  expect(captured.props?.fill).toBe(true);
  view.rerender(
    <PluginPanel {...values} spec={{ ...spec, bridge: undefined }} />,
  );
  expect(captured.props?.state).not.toHaveProperty("session");
  expect(captured.props?.stream).toBeUndefined();
  view.rerender(<PluginPanel {...values} sessionBridge={undefined} />);
  expect(captured.props?.state).not.toHaveProperty("session");
});
