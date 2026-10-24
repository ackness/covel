import { requestConfirm } from "@/lib/confirm-channel.js";
import {
  act,
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
import {
  getDesktopInfo,
  hasElectronIpc,
  reloadServerAndWait,
} from "@/lib/desktop-bridge.js";
import type * as DesktopBridge from "@/lib/desktop-bridge.js";

const boot = vi.hoisted(() => vi.fn());
vi.mock("@/stores/session-store.js", () => ({
  useSessionActions: () => ({ boot }),
}));

const desktopInfoFixture = {
  version: "test",
  platform: "darwin",
  isDev: false,
  covelHome: "/home",
  dataRoot: "/data",
  logsDir: "/logs",
  dbPath: "/data/covel.db",
  configTomlPath: "/home/config.toml",
  llmTomlPath: "/home/llm.toml",
  keysEnvPath: "/home/keys.env",
  serverPort: 9479,
};

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

vi.mock("@/lib/desktop-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DesktopBridge>()),
  hasElectronIpc: vi.fn().mockReturnValue(false),
  getDesktopInfo: vi.fn().mockResolvedValue(null),
  reloadServerAndWait: vi.fn().mockResolvedValue(true),
}));

describe("PackagesPane installed plugin management", () => {
  beforeEach(async () => {
    boot.mockReset();
    vi.mocked(requestConfirm).mockReset().mockResolvedValue(true);
    vi.mocked(hasElectronIpc).mockReset().mockReturnValue(false);
    vi.mocked(getDesktopInfo).mockReset().mockResolvedValue(null);
    vi.mocked(reloadServerAndWait).mockReset().mockResolvedValue(true);
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "respects development server ownership after uninstall (isDev=%s)",
    async (isDev) => {
      vi.mocked(hasElectronIpc).mockReturnValue(true);
      vi.mocked(getDesktopInfo).mockResolvedValue({
        ...desktopInfoFixture,
        isDev,
      });
      let installedOnDisk = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/install/worlds")
            return Response.json({ items: [] });
          if (url === "/api/install/plugins") {
            return Response.json({
              items: installedOnDisk
                ? [
                    {
                      id: brokenPlugin.id,
                      version: null,
                      source: null,
                      pendingUpdate: null,
                    },
                  ]
                : [],
            });
          }
          if (url === "/api/plugins") {
            return Response.json({
              items: installedOnDisk ? [brokenPlugin] : [],
            });
          }
          if (
            url === "/api/plugins/broken-plugin" &&
            init?.method === "DELETE"
          ) {
            installedOnDisk = false;
            return Response.json({
              ok: true,
              id: brokenPlugin.id,
              restartRequired: true,
            });
          }
          throw new Error(
            `Unexpected request: ${init?.method ?? "GET"} ${url}`,
          );
        }),
      );
      render(<PackagesPane />);
      await screen.findByText("Broken plugin");
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
      const restart = await screen.findByRole("button", {
        name: i18n.t("settings.packages.restartNow"),
      });
      expect((restart as HTMLButtonElement).disabled).toBe(isDev);
      if (isDev) {
        expect(
          screen.getByText(i18n.t("settings.desktopRestartDevHint")),
        ).toBeTruthy();
      }
      fireEvent.click(restart);
      expect(reloadServerAndWait).toHaveBeenCalledTimes(isDev ? 0 : 1);
    },
  );

  it.each([
    { failure: "rejected", isDev: false },
    { failure: "rejected", isDev: true },
    { failure: "missing", isDev: false },
  ])(
    "retries $failure desktop information and restores isDev=$isDev behavior",
    async ({ failure, isDev }) => {
      vi.mocked(hasElectronIpc).mockReturnValue(true);
      let resolveInitial!: (info: typeof desktopInfoFixture | null) => void;
      let rejectInitial!: (error: Error) => void;
      let resolveRetry!: (info: typeof desktopInfoFixture) => void;
      vi.mocked(getDesktopInfo)
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolveInitial = resolve;
            rejectInitial = reject;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveRetry = resolve;
          }),
        );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url === "/api/plugins")
            return Response.json({ items: [brokenPlugin] });
          if (url === "/api/install/plugins")
            return Response.json({
              items: [
                {
                  id: brokenPlugin.id,
                  version: null,
                  source: null,
                  pendingUpdate: null,
                },
              ],
            });
          if (url === "/api/install/worlds")
            return Response.json({ items: [] });
          if (url === "/api/plugins/broken-plugin" && init?.method === "DELETE")
            return Response.json({
              ok: true,
              id: brokenPlugin.id,
              restartRequired: true,
            });
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      render(<PackagesPane />);
      await screen.findByText("Broken plugin");
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
      const restart = await screen.findByRole<HTMLButtonElement>("button", {
        name: i18n.t("settings.packages.restartNow"),
      });
      expect(restart.disabled).toBe(true);
      expect(
        screen.getByText(i18n.t("settings.packages.restartInfoLoading")),
      ).toBeTruthy();
      expect(
        screen.queryByText(i18n.t("settings.packages.restartHint")),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: i18n.t("common.retry") }),
      ).toBeNull();

      await act(async () => {
        if (failure === "rejected") rejectInitial(new Error("IPC unavailable"));
        else resolveInitial(null);
      });
      expect(
        screen.getByText(i18n.t("settings.packages.restartInfoFailed")),
      ).toBeTruthy();
      expect(
        screen.queryByText(i18n.t("settings.packages.restartInfoLoading")),
      ).toBeNull();
      fireEvent.click(restart);
      expect(reloadServerAndWait).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("common.retry") }),
      );
      expect(getDesktopInfo).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(i18n.t("settings.packages.restartInfoLoading")),
      ).toBeTruthy();
      expect(
        screen.queryByText(i18n.t("settings.packages.restartInfoFailed")),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: i18n.t("common.retry") }),
      ).toBeNull();
      expect(restart.disabled).toBe(true);
      fireEvent.click(restart);
      expect(reloadServerAndWait).not.toHaveBeenCalled();

      await act(async () => resolveRetry({ ...desktopInfoFixture, isDev }));
      expect(
        screen.getByText(
          i18n.t(
            isDev
              ? "settings.desktopRestartDevHint"
              : "settings.packages.restartHint",
          ),
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText(i18n.t("settings.packages.restartInfoLoading")),
      ).toBeNull();
      expect(restart.disabled).toBe(isDev);
      fireEvent.click(restart);
      expect(reloadServerAndWait).toHaveBeenCalledTimes(isDev ? 0 : 1);
    },
  );

  it("keeps usable community plugins listed with their load warnings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/install/worlds") return Response.json({ items: [] });
        if (url === "/api/install/plugins")
          return Response.json({
            items: [
              {
                id: "partial",
                version: null,
                source: null,
                pendingUpdate: null,
              },
            ],
          });
        if (url === "/api/plugins")
          return Response.json({
            items: [
              {
                ...brokenPlugin,
                id: "partial",
                displayName: "Partial plugin",
                hostState: "installed",
                error: undefined,
                disabledRuntimes: [
                  {
                    sourcePath: "PLUGIN.md",
                    message: "PLUGIN.md: runtime.schedule.stage: required",
                  },
                ],
                ignoredFields: [
                  {
                    sourcePath: "PLUGIN.md",
                    field: "futureFeature",
                    message: "PLUGIN.md: futureFeature: unknown field",
                  },
                ],
              },
            ],
          });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(<PackagesPane />);
    const name = await screen.findByText("Partial plugin");
    const row = name.closest("li")!;
    const warnings = within(row).getByRole("list", {
      name: "Plugin load warnings",
    });
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(2);
    expect(within(row).getByRole("button", { name: "Uninstall" })).toBeTruthy();
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
    expect(
      screen.getByText(i18n.t("settings.packages.restartHint")),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: i18n.t("settings.packages.restartNow"),
      }),
    ).toBeNull();
    expect(
      screen.queryByText(i18n.t("settings.packages.restartInfoLoading")),
    ).toBeNull();
    expect(getDesktopInfo).not.toHaveBeenCalled();
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
