import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionPlugin } from "@covel/shared";
import i18n from "@/i18n";
import { SessionPluginItem } from "../session-plugin-item.js";
const plugin: SessionPlugin = {
  id: "probe",
  displayName: "Probe",
  description: "",
  source: "community",
  kind: "plugin",
  executionMode: "code" as const,
  hostState: "loaded",
  runtimeCount: 0,
  provides: [],
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
  active: true,
  locked: false,
  serverCodeApproved: true,
  sessionState: "active",
};
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
it.each(["trusted-source", "session"] as const)(
  "labels only implicit source approvals (%s)",
  (serverCodeApprovedBy) => {
    render(<SessionPluginItem plugin={{ ...plugin, serverCodeApprovedBy }} />);
    expect(!!screen.queryByText("auto-approved: trusted source")).toBe(
      serverCodeApprovedBy === "trusted-source",
    );
  },
);

it("shows declarative status without claiming trusted-source or code authorization", () => {
  render(
    <SessionPluginItem
      plugin={{
        ...plugin,
        executionMode: "declarative",
        serverCodeApproved: false,
        approvalRequired: false,
      }}
    />,
  );
  expect(
    screen.getByText(
      "Settings-only plugin · no approval needed",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("auto-approved: trusted source")).toBeNull();
  expect(screen.queryByTestId("plugin-model-notice")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});
