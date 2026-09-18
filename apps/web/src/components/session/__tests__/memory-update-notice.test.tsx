import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  __clearAllPluginDataForTest,
  applyChanges,
  setActiveSession,
} from "@/stores/plugin-data-store.js";
import { MemoryUpdateNotice } from "../memory-update-notice.js";
import { RuntimeModelBindings } from "../plugin-list-panel/runtime-model-bindings.js";

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      session: { activePlugins: ["custom-panel"] },
      plugins: [{ id: "custom-panel", capabilities: ["memory-panel"] }],
    },
  }),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  __clearAllPluginDataForTest();
  setActiveSession("session-a");
});

it("shows a persisted failure, isolates sessions and clears after recovery", () => {
  const update = (value: unknown) =>
    applyChanges("custom-panel", [
      { namespace: "_memory", key: "update", value, operation: "set" },
    ]);
  update({ status: "failed", error: "Provider unavailable" });
  render(<MemoryUpdateNotice />);
  expect(screen.getByRole("status").textContent).toContain(
    "Provider unavailable",
  );
  act(() => setActiveSession("session-b"));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => setActiveSession("session-a"));
  expect(screen.getByRole("status")).toBeTruthy();
  act(() => update({ status: "succeeded", updated: true }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not offer a model binding for an inert UI-only declaration", () => {
  const common = {
    runtimeType: "agent" as const,
    execution: "sync" as const,
    turnCompletion: { mode: "await" as const },
    outputKind: "plugin" as const,
    capabilities: [],
    tags: [],
    trigger: { type: "auto" as const },
  };
  render(
    <RuntimeModelBindings
      runtimes={[
        { ...common, id: "custom-panel" },
        { ...common, id: "agent", stage: "narrative" },
        { ...common, id: "manual", trigger: { type: "manual" } },
      ]}
    />,
  );
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(screen.queryByText("custom-panel")).toBeNull();
});
