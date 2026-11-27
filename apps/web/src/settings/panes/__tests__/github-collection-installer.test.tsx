import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GithubCollectionPreview } from "@covel/shared";
import { GithubCollectionInstaller } from "../GithubCollectionInstaller.js";
import i18n from "@/i18n";

const desktopMocks = vi.hoisted(() => ({
  isDesktopApp: vi.fn(() => false),
  setDesktopProxyConfig: vi.fn(),
}));

vi.mock("@/lib/desktop-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-bridge.js")>()),
  isDesktopApp: desktopMocks.isDesktopApp,
  setDesktopProxyConfig: desktopMocks.setDesktopProxyConfig,
}));

const source = {
  repository: "https://github.com/example/pack",
  commit: "a".repeat(40),
  path: "plugins/barrow-dice",
  digest: "b".repeat(64),
  tracking: { kind: "default-branch" as const },
};
const plugin = {
  kind: "plugin" as const,
  id: "barrow-dice",
  version: "1.0.0",
  description: "Dice for the barrow",
  author: "Barrow Works",
  executionMode: "code" as const,
  hasServerCode: true,
  trustedSource: false,
  capabilities: {
    serverCode: true,
    http: [],
    hooks: [],
    tools: [],
    actions: [],
    services: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  },
  source,
  token: "plugin-token",
  expiresAt: Date.now() + 900_000,
};
const world = {
  ...plugin,
  kind: "world" as const,
  id: "barrow",
  description: "A tabletop world",
  executionMode: "declarative" as const,
  hasServerCode: false,
  source: { ...source, path: "worlds/barrow" },
  token: "world-token",
};
const pack: GithubCollectionPreview = {
  collection: {
    id: "barrow-pack",
    name: "Barrow Pack",
    version: "1.2.0",
    author: null,
  },
  items: [plugin, world],
  problems: [],
};

const consent = () =>
  screen.getByLabelText(
    "I understand the risks and trust this source.",
  ) as HTMLInputElement;
const packageBox = (id: string) =>
  screen.getByRole("checkbox", { name: new RegExp(id) }) as HTMLInputElement;
const installButton = (count: number) =>
  screen.getByRole("button", {
    name: `Install ${count} selected`,
  }) as HTMLButtonElement;

async function previewWith(result: GithubCollectionPreview) {
  const batches: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/install/github/preview") return Response.json(result);
      expect(url).toBe("/api/install/github/batch");
      const body = JSON.parse(String(init?.body));
      expect(body.acceptRisk).toBe(true);
      batches.push(body.tokens);
      return Response.json(
        {
          ok: true,
          installed: result.items
            .filter((item) => body.tokens.includes(item.token))
            .map(({ kind, id }) => ({ kind, id })),
          restartRequired: true,
        },
        { status: 201 },
      );
    }),
  );
  const installed = vi.fn();
  render(
    <GithubCollectionInstaller
      onInstalled={installed}
      onBusyChange={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: source.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("Collection: Barrow Pack · 1.2.0");
  return { installed, batches };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  desktopMocks.isDesktopApp.mockReset().mockReturnValue(false);
  desktopMocks.setDesktopProxyConfig.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("installs a plugin and a world together after one consent", async () => {
  const { installed, batches } = await previewWith(pack);

  expect(packageBox("barrow-dice").checked).toBe(true);
  expect(packageBox("Dice for the barrow")).toBe(packageBox("barrow-dice"));
  expect(installButton(2).disabled).toBe(true);
  // A mixed selection states both the code risk and the world notice.
  expect(screen.getByText(/without a process sandbox/)).toBeTruthy();
  expect(
    screen.getByText(/Installing does not authorize plugins/),
  ).toBeTruthy();

  fireEvent.click(consent());
  fireEvent.click(installButton(2));

  await waitFor(() =>
    expect(installed).toHaveBeenCalledWith(
      expect.objectContaining({
        installed: [
          { kind: "plugin", id: "barrow-dice" },
          { kind: "world", id: "barrow" },
        ],
      }),
    ),
  );
  expect(batches).toEqual([["plugin-token", "world-token"]]);
  expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
});

it("asks for consent again when the selection changes and installs only what stays ticked", async () => {
  const { installed, batches } = await previewWith(pack);

  fireEvent.click(consent());
  fireEvent.click(packageBox("Dice for the barrow"));
  expect(consent().checked).toBe(false);
  expect(installButton(1).disabled).toBe(true);

  fireEvent.click(consent());
  fireEvent.click(installButton(1));

  await waitFor(() => expect(installed).toHaveBeenCalledTimes(1));
  expect(batches).toEqual([["world-token"]]);
  // The package left out stays in the list for a later install.
  expect(packageBox("Dice for the barrow").checked).toBe(false);
});

it("blocks a selection that contains a package with an error until it is unticked", async () => {
  await previewWith({
    ...pack,
    problems: [
      {
        level: "error",
        packageId: "barrow",
        message: "World barrow requires action-check@2.",
      },
    ],
  });

  fireEvent.click(consent());
  expect(
    screen.getByText("World barrow requires action-check@2."),
  ).toBeTruthy();
  expect(installButton(2).disabled).toBe(true);

  fireEvent.click(packageBox("A tabletop world"));
  fireEvent.click(consent());
  expect(installButton(1).disabled).toBe(false);
});

it("drops the preview when the URL changes", async () => {
  await previewWith(pack);

  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "https://github.com/another/pack" },
  });

  expect(screen.queryByText("Collection: Barrow Pack · 1.2.0")).toBeNull();
  expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
});

it("resolves plugin and world descriptions when the UI language changes", async () => {
  await previewWith({
    ...pack,
    items: [
      {
        ...plugin,
        description: { en: "English plugin", "zh-CN": "中文插件简介" },
      },
      {
        ...world,
        description: { en: "English world", "zh-CN": "中文世界简介" },
      },
    ],
  });
  expect(screen.getByText("English plugin")).toBeTruthy();
  expect(screen.getByText("English world")).toBeTruthy();
  await i18n.changeLanguage("zh-CN");
  expect(await screen.findByText("中文插件简介")).toBeTruthy();
  expect(await screen.findByText("中文世界简介")).toBeTruthy();
  expect(screen.queryByText("English plugin")).toBeNull();
});

it("organizes multi-plugin repositories with search, folder filters, installed badges, and quick official repo preview", async () => {
  const catalog: GithubCollectionPreview = {
    collection: null,
    items: [
      {
        ...plugin,
        id: "story-note",
        displayName: "Story Note Demo",
        description: "Demo example plugin",
        tags: ["demo"],
        source: {
          ...source,
          repository: "https://github.com/covel-ai/covel-plugins",
          path: "examples/story-note",
        },
        token: "tok-demo",
      },
      {
        ...plugin,
        id: "openai-codex",
        displayName: "OpenAI Codex",
        description: "ChatGPT subscription provider",
        tags: ["provider", "codex"],
        source: {
          ...source,
          repository: "https://github.com/covel-ai/covel-plugins",
          path: "plugins/openai-codex",
        },
        token: "tok-codex",
      },
      {
        ...plugin,
        id: "mimo-tts",
        displayName: "MiMo TTS",
        description: "Speech synthesis plugin",
        tags: ["tts"],
        source: {
          ...source,
          repository: "https://github.com/covel-ai/covel-plugins",
          path: "plugins/mimo-tts",
        },
        token: "tok-tts",
      },
    ],
    problems: [],
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/install/github/preview");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://github.com/covel-ai/covel-plugins",
      });
      return Response.json(catalog);
    }),
  );

  render(
    <GithubCollectionInstaller
      onInstalled={() => undefined}
      onBusyChange={() => undefined}
      installedPluginIds={new Set(["mimo-tts"])}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Official plugins/i }));
  await screen.findByText("OpenAI Codex");

  // Multi-package directory scans start unselected and sort plugins/ before examples/.
  const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(checkboxes.every((box) => !box.checked)).toBe(true);
  const labels = checkboxes.map((box) => box.closest("li")?.textContent ?? "");
  expect(labels[0]).toContain("OpenAI Codex");
  expect(labels[1]).toContain("MiMo TTS");
  expect(labels[1]).toContain("Installed");
  expect(labels[2]).toContain("Story Note Demo");

  // Filter by folder
  fireEvent.click(screen.getByRole("button", { name: "examples/ (1)" }));
  expect(screen.queryByText("OpenAI Codex")).toBeNull();
  expect(screen.getByText("Story Note Demo")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "All folders (3)" }));

  // Search by tag/name
  const search = screen.getByPlaceholderText(/Search by name/i);
  fireEvent.change(search, { target: { value: "codex" } });
  expect(screen.getByText("OpenAI Codex")).toBeTruthy();
  expect(screen.queryByText("MiMo TTS")).toBeNull();

  // Tick and verify selection chip appears
  fireEvent.click(packageBox("openai-codex"));
  expect(installButton(1).disabled).toBe(true);
  expect(
    screen.getByRole("button", { name: "Remove openai-codex from selection" }),
  ).toBeTruthy();
});

it("offers one-click switch to system proxy and retry when GitHub preview hits outbound_network_error", async () => {
  desktopMocks.isDesktopApp.mockReturnValue(true);
  desktopMocks.setDesktopProxyConfig.mockResolvedValue({
    mode: "system",
    effective: "system",
    systemAvailable: true,
  });

  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/install/github/preview") {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            {
              error: "Upstream network request failed (ECONNRESET)",
              code: "outbound_network_error",
              details: {
                transportCode: "ECONNRESET",
                proxyMode: "direct",
                proxyEffective: "direct",
                systemProxyAvailable: true,
              },
            },
            { status: 502 },
          );
        }
        return Response.json(pack);
      }
      throw new Error(`Unexpected url: ${url}`);
    }),
  );

  render(
    <GithubCollectionInstaller
      onInstalled={() => undefined}
      onBusyChange={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: source.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));

  await screen.findByText("ECONNRESET");
  fireEvent.click(
    screen.getByRole("button", { name: "Use system proxy & retry" }),
  );

  await waitFor(() =>
    expect(desktopMocks.setDesktopProxyConfig).toHaveBeenCalledWith({
      mode: "system",
    }),
  );
  await screen.findByText("Collection: Barrow Pack · 1.2.0");
});
