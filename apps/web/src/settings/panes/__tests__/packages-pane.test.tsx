import { requestConfirm } from "@/lib/confirm-channel.js";
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

const boot = vi.hoisted(() => vi.fn());
vi.mock("@/stores/session-store.js", () => ({
  useSessionActions: () => ({ boot }),
}));

const brokenPlugin: PluginSummary = {
  requires: [],
  optional: [],
  conflicts: [],
  extensions: [],
  eventTopics: [],
  id: "broken-plugin",
  displayName: "Broken plugin",
  description: "",
  source: "community",
  kind: "plugin",
  hostState: "error",
  error: "Invalid manifest",
  runtimeCount: 0,
  provides: [],
  tags: [],
  runtimes: [],
  tools: [],
  userSettings: [],
  languages: { text: ["en"], instructions: ["en"] },
};

vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm: vi.fn() }));

describe("PackagesPane installed plugin management", () => {
  beforeEach(async () => {
    boot.mockReset();
    vi.mocked(requestConfirm).mockReset().mockResolvedValue(true);
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("F-191 confirms uninstalling failed community plugins", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/install/worlds") return Response.json({ items: [] });
        if (url === "/api/install/plugins")
          return Response.json({
            items: [
              {
                id: "broken-plugin",
                version: null,
                source: null,
                pendingUpdate: null,
              },
            ],
          });
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
    vi.mocked(requestConfirm).mockResolvedValueOnce(false);
    fireEvent.click(within(row!).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(requestConfirm).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
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

  it("loads the world list again after a world package is installed", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/install/worlds") return Response.json({ items: [] });
        if (url === "/api/install/plugins") return Response.json({ items: [] });
        if (url === "/api/plugins" && !init?.method)
          return Response.json({ items: [] });
        if (url === "/api/install/world" && init?.method === "POST")
          return Response.json({
            ok: true,
            kind: "world",
            id: "new-world",
            restartRequired: false,
          });
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<PackagesPane />);
    const zone = (await screen.findByText("World package")).closest("label")!;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [
          new File(["zip"], "new-world.zip", { type: "application/zip" }),
        ],
      },
    });

    await waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Installed new-world",
      ),
    );
  });
});

it("F-090 announces a collection ZIP that installs no packages", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/install/collection")
        return Response.json({
          ok: true,
          installed: [],
          restartRequired: false,
        });
      return Response.json({ items: [] });
    }),
  );
  render(<PackagesPane />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByTestId("install-collection-file-input"), {
    target: {
      files: [new File(["zip"], "empty.zip", { type: "application/zip" })],
    },
  });
  expect((await screen.findByRole("status")).textContent).toBe(
    i18n.t("settings.packages.nothingInstalled"),
  );
});
