import { existsSync } from "node:fs";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { MODE_MS } from "../components/Hero.js";
import { COPY, LANGS, PLUGIN_IDS } from "../copy.js";
import { PACKS } from "../packs.js";
import { detectPlatform, pickDownload } from "../download.js";

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("showcase site", () => {
  it("shows the language asked for in the query and switches on request", () => {
    window.history.replaceState(null, "", "/?lang=zh");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      COPY.zh.hero.lead,
    );
    expect(document.documentElement.lang).toBe("zh-CN");

    fireEvent.click(
      screen.getByRole("button", { name: COPY.zh.nav.languageLabel }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      COPY.en.hero.lead,
    );
    expect(window.localStorage.getItem("covel-site:lang")).toBe("en");
  });

  it("cycles the ways to play and lights up each one's plugins", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const selected = () =>
        screen.getByRole("tab", { selected: true }).textContent;
      const lit = () =>
        screen.getByTestId("plugin-rack").querySelectorAll('[data-on="true"]')
          .length;
      const [first, second, third] = COPY.en.hero.modes;
      expect(selected()).toContain(first?.word.replace(/\.$/, ""));
      expect(lit()).toBe(PACKS.stage.length);

      act(() => vi.advanceTimersByTime(MODE_MS));
      expect(selected()).toContain(second?.word.replace(/\.$/, ""));
      expect(lit()).toBe(PACKS.tabletop.length);

      fireEvent.click(
        screen.getByRole("tab", {
          name: third?.word.replace(/\.$/, "") ?? "",
        }),
      );
      expect(lit()).toBe(PACKS.story.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has a picture for every world it lists", () => {
    for (const lang of LANGS) {
      for (const world of COPY[lang].worlds.list) {
        const file = path.join(
          import.meta.dirname,
          "../../public/worlds",
          `${world.id}.webp`,
        );
        expect(existsSync(file), world.id).toBe(true);
      }
    }
  });

  it("lists the same worlds, steps and plugins in both languages", () => {
    const shape = (lang: (typeof LANGS)[number]) => ({
      worlds: COPY[lang].worlds.list.map((world) => world.id),
      modes: COPY[lang].hero.modes.map((mode) => mode.visual),
      points: [
        COPY[lang].pillars.plugin.points.length,
        COPY[lang].pillars.world.points.length,
      ],
      plugins: COPY[lang].core.items.map((item) => item.ids),
      links: COPY[lang].pillars.links.map((link) => link.href),
    });
    expect(shape("zh")).toEqual(shape("en"));
  });

  it("only lights up plugins the repository ships", () => {
    const plugins = path.join(import.meta.dirname, "../../../../plugins");
    const named = [
      ...PLUGIN_IDS,
      ...Object.values(PACKS).flat(),
      ...COPY.en.core.items.flatMap((item) => item.ids.split(" · ")),
    ];
    for (const id of new Set(named)) {
      expect(existsSync(path.join(plugins, id, "PLUGIN.md")), id).toBe(true);
    }
  });
});

describe("download links", () => {
  const assets = [
    "Covel-electron-0.0.50-mac-arm64.dmg",
    "Covel-electron-0.0.50-mac-arm64.zip",
    "Covel-electron-0.0.50-win-x64-portable.exe",
    "Covel-electron-0.0.50-win-x64.exe",
    "SHA256SUMS.txt",
  ].map((name) => ({ name, browser_download_url: `https://dl/${name}` }));

  it("picks the installer, and on Windows the portable build too", () => {
    expect(pickDownload(assets, "mac")).toEqual({
      href: "https://dl/Covel-electron-0.0.50-mac-arm64.dmg",
      platform: "mac",
    });
    expect(pickDownload(assets, "windows")).toEqual({
      href: "https://dl/Covel-electron-0.0.50-win-x64.exe",
      platform: "windows",
      portable: "https://dl/Covel-electron-0.0.50-win-x64-portable.exe",
    });
    expect(pickDownload(assets.slice(0, 2), "windows")).toBeUndefined();
  });

  it("recognises desktop systems and leaves phones to the release page", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    expect(detectPlatform({ userAgent: mac })).toBe("mac");
    expect(detectPlatform({ userAgent: win })).toBe("windows");
    expect(detectPlatform({ userAgent: iphone })).toBeUndefined();
    expect(detectPlatform({ userAgent: "X11; Linux x86_64" })).toBeUndefined();
  });

  it("links the visitor's installer once the latest release is known", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ assets }) }),
    );
    render(<App />);
    const [button] = await screen.findAllByRole("link", {
      name: COPY.en.hero.primaryFor.windows,
    });
    expect(button?.getAttribute("href")).toBe(
      "https://dl/Covel-electron-0.0.50-win-x64.exe",
    );
    const [portable] = screen.getAllByRole("link", {
      name: COPY.en.hero.portable,
    });
    expect(portable?.getAttribute("href")).toBe(
      "https://dl/Covel-electron-0.0.50-win-x64-portable.exe",
    );
  });
});
