import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { PackagesPane } from "../PackagesPane.js";

const brokenPlugin: PluginSummary = {
  id: "broken-plugin",
  displayName: "Broken plugin",
  description: "",
  source: "community",
  pluginType: "plugin",
  status: "error",
  error: "Invalid manifest",
  runtimeCount: 0,
  capabilities: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
};

describe("PackagesPane installed plugin management", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps failed community plugins visible and allows uninstalling them", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/plugins" && !init?.method) {
          return Response.json({
            items: [
              brokenPlugin,
              {
                ...brokenPlugin,
                id: "builtin-plugin",
                displayName: "Builtin plugin",
                source: "builtin",
              },
            ],
          });
        }
        if (url === "/api/plugins/broken-plugin" && init?.method === "DELETE") {
          return Response.json({
            ok: true,
            id: brokenPlugin.id,
            restartRequired: true,
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<PackagesPane />);
    const name = await screen.findByText("Broken plugin");
    expect(screen.queryByText("Builtin plugin")).toBeNull();
    const row = name.closest("li");
    expect(row).not.toBeNull();
    fireEvent.click(within(row!).getByRole("button", { name: "Uninstall" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plugins/broken-plugin",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/plugins"),
      ).toHaveLength(2),
    );
  });
});
