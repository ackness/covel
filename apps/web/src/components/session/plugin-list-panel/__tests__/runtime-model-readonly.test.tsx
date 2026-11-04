import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { PluginListPanel } from "../../plugin-list-panel.js";

beforeAll(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

const fixturePlugin: PluginSummary = {
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  id: "fixture",
  displayName: "Fixture",
  description: "Fixture plugin",
  kind: "plugin",
  source: "builtin",
  executionMode: "code" as const,
  hostState: "loaded",
  runtimeCount: 1,
  provides: [],
  tags: [],
  runtimes: [
    {
      id: "fixture/runtime",
      runtimeType: "agent",
      model: "text",
      trigger: { type: "auto" },
      execution: "sync",
      turnCompletion: { mode: "await" },
      outputKind: "system",
      outputContract: undefined,
    },
  ],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
};
const slots = [
  {
    slotId: "text",
    presetId: "p",
    preset: null,
    label: "text",
    tag: "text",
    serverModel: "fixture-model",
  },
];

it("shows each step's model as text with a link to Settings, never a select", () => {
  const onOpenModelSettings = vi.fn();
  render(
    <PluginListPanel
      plugins={[fixturePlugin]}
      sessionId="s"
      resolvedSlots={slots}
      onOpenModelSettings={onOpenModelSettings}
    />,
  );
  fireEvent.click(screen.getByText("Fixture"));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText(/fixture-model/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go to settings" }));
  expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
});

it("reads a saved override from the session without offering to change it", () => {
  render(
    <PluginListPanel
      plugins={[fixturePlugin]}
      sessionId="s"
      resolvedSlots={[
        ...slots,
        {
          slotId: "quality",
          presetId: "q",
          preset: null,
          label: "quality",
          tag: "text",
          serverModel: "better-model",
        },
      ]}
      runtimeModelOverrides={{ "fixture/runtime": "quality" }}
    />,
  );
  fireEvent.click(screen.getByText("Fixture"));
  expect(screen.getByText(/better-model/)).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("hides stage badges and the technical list outside developer mode", () => {
  const view = render(
    <PluginListPanel plugins={[fixturePlugin]} sessionId="s" />,
  );
  fireEvent.click(screen.getByText("Fixture"));
  expect(screen.queryByText(/^Steps$/)).toBeNull();
  view.rerender(
    <PluginListPanel plugins={[fixturePlugin]} sessionId="s" developerMode />,
  );
  expect(screen.getByText(/^Steps$/)).toBeTruthy();
});
