import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlugin } from "@covel/shared";
import i18n from "@/i18n";
import { SessionPluginItem } from "../plugin-list-panel/session-plugin-item.js";
const { resume, load } = vi.hoisted(() => ({ resume: vi.fn(), load: vi.fn() }));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  resumeSessionPluginFault: resume,
}));
vi.mock("@/stores/session-store.js", () => ({
  useSessionActions: () => ({ loadSessionPlugins: load }),
}));
const plugin: SessionPlugin = {
  id: "p",
  displayName: "Probe",
  description: "Probe",
  kind: "plugin",
  source: "builtin",
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
  serverCodeApproved: true,
  sessionState: "active",
  locked: false,
  paused: { reason: "runtime" },
};
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  resume.mockResolvedValue({ items: [], commands: [], unavailable: [] });
  load.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe("plugin fault recovery", () => {
  it("shows the badge and resumes the selected plugin", async () => {
    render(<SessionPluginItem plugin={plugin} sessionId="s" />);
    expect(screen.getByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("s", "p"));
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
  });
  it("hides fault recovery for an unpaused plugin", () => {
    render(
      <SessionPluginItem
        plugin={{ ...plugin, paused: undefined }}
        sessionId="s"
      />,
    );
    expect(screen.queryByText("Paused")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});
