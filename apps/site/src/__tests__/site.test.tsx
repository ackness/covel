import { SKILL_INSTALL_COMMAND } from "../components/SkillInstall.js";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { BEAT_MS, MODE_MS } from "../components/Hero.js";
import { COPY, LANGS, PLUGIN_IDS, initialLang } from "../copy.js";
import { MOMENT_PLUGINS, WORLD_IDS, PACKS } from "../packs.js";
import {
  detectPlatform,
  pickDownload,
  listDownloads,
  releaseAssets,
} from "../download.js";
import { Downloads } from "../components/Downloads.js";
import { PREVIEW_ART } from "../preview-copy.js";
import { RELEASES_URL } from "../links.js";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
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

const hero = () => within(document.getElementById("top")!);

// Exercise the actual pre-paint script, which React tests do not load.
const themeBootstrap = readFileSync(
  path.resolve("index.html"),
  "utf8",
).match(/<script>([\s\S]*?)<\/script>/)?.[1];

function restoreTheme(storage: Pick<Storage, "getItem"> = localStorage) {
  if (!themeBootstrap) throw new Error("Missing pre-paint theme bootstrap");
  runInNewContext(themeBootstrap, { document, localStorage: storage });
}

describe("visitor preferences", () => {
  it.each([null, "system", "invalid"])(
    "defaults to dark before rendering when the saved theme is %s",
    (stored) => {
      document.documentElement.dataset.theme = "light";
      restoreTheme({ getItem: () => stored });
      expect(document.documentElement.dataset.theme).toBe("dark");
    },
  );

  it("defaults to dark when browser storage is unavailable", () => {
    restoreTheme({
      getItem: () => {
        throw new Error("Storage blocked");
      },
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("restores each manually selected theme when the page loads again", () => {
    let app = render(<App />);
    for (const theme of ["light", "dark"] as const) {
      fireEvent.click(
        screen.getByRole("button", {
          name: theme === "light" ? COPY.en.nav.toLight : COPY.en.nav.toDark,
        }),
      );
      expect(localStorage.getItem("covel-site:theme")).toBe(theme);
      app.unmount();
      document.documentElement.removeAttribute("data-theme");
      restoreTheme();
      app = render(<App />);
      expect(document.documentElement.dataset.theme).toBe(theme);
      expect(
        screen.getByRole("button", {
          name: theme === "light" ? COPY.en.nav.toDark : COPY.en.nav.toLight,
        }),
      ).toBeTruthy();
    }
  });

  it.each(LANGS)("remembers %s on a return visit without a language URL", (lang) => {
    let app = render(<App />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", {
        name: lang === "zh" ? "简体中文" : "English",
      }),
    );
    app.unmount();
    window.history.replaceState(null, "", "/");
    app = render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      COPY[lang].hero.lead,
    );
    expect(localStorage.getItem("covel-site:lang")).toBe(lang);
    app.unmount();
  });
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
      screen.getByRole("combobox", { name: COPY.zh.nav.languageLabel }),
    );
    fireEvent.click(screen.getByRole("option", { name: "English" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      COPY.en.hero.lead,
    );
    expect(window.localStorage.getItem("covel-site:lang")).toBe("en");
    expect(window.location.search).toBe("?lang=en");
    expect(initialLang()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(hero().getByRole("tabpanel").textContent).toContain(
      COPY.en.preview.stage.dialogue,
    );
  });

  it("offers a themed language picker with keyboard selection and dismissal", () => {
    render(<App />);
    const picker = screen.getByRole("combobox", {
      name: COPY.en.nav.languageLabel,
    });
    expect(picker.tagName).toBe("BUTTON");
    picker.focus();
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(picker);
    fireEvent.keyDown(picker, { key: "Home" });
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(document.documentElement.lang).toBe("zh-CN");
    fireEvent.click(picker);
    fireEvent.pointerDown(document.body);
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker);
  });

  it("keeps quick navigation and separate creation paths", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: COPY.en.nav.quick });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["#features", "#plugins", "#create", "#worlds", "#downloads"]);
    expect(document.querySelector("button nav")).toBeNull();
    const creation = within(document.getElementById("create")!);
    expect(
      creation.getByRole("heading", { name: COPY.en.creation.app.title }),
    ).toBeTruthy();
    expect(
      creation.getByRole("heading", { name: COPY.en.creation.skills.title }),
    ).toBeTruthy();
    for (const name of ["create-world", "create-plugin"])
      expect(
        creation
          .getByRole("link", { name: new RegExp(name) })
          .getAttribute("href"),
      ).toContain(`/skills/${name}/SKILL.md`);
  });

  it("copies the scoped skill command and identifies optional media extensions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App />);
    const creation = within(document.getElementById("create")!);
    fireEvent.click(
      creation.getByRole("button", {
        name: COPY.en.creation.skills.copyCommand,
      }),
    );
    await creation.findByText(COPY.en.creation.skills.copied);
    expect(writeText).toHaveBeenCalledWith(SKILL_INSTALL_COMMAND);
    expect(SKILL_INSTALL_COMMAND).toBe(
      "npx skills add ackness/covel --skill create-world --skill create-plugin",
    );
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(
      creation.getByRole("button", {
        name: COPY.en.creation.skills.copyCommand,
      }),
    );
    await creation.findByText(COPY.en.creation.skills.copyFailed);
    expect(creation.getByText(SKILL_INSTALL_COMMAND)).toBeTruthy();
    expect(screen.getByText(COPY.en.extensions.note)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "MiMo Narration" }).getAttribute("href"),
    ).toContain("/plugins/mimo-tts");
    expect(
      screen.getByRole("link", { name: "OpenAI Images" }).getAttribute("href"),
    ).toContain("/plugins/openai-image-gen");
  });

  it("cycles the ways to play and lights up each one's plugins", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const selected = () =>
        hero().getByRole("tab", { selected: true }).textContent;
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
        hero().getByRole("tab", {
          name: third?.word.replace(/\.$/, "") ?? "",
        }),
      );
      expect(lit()).toBe(PACKS.story.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances plugin moments before changing worlds and lets readers inspect a moment", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const currentMoment = () => hero().getByRole("button", { pressed: true });
      expect(currentMoment().textContent).toContain(
        COPY.en.journey.stage[0]?.title,
      );
      expect(
        document
          .querySelector(".preview-stage-reply")
          ?.getAttribute("aria-hidden"),
      ).toBe("true");
      act(() => vi.advanceTimersByTime(BEAT_MS));
      expect(currentMoment().textContent).toContain(
        COPY.en.journey.stage[1]?.title,
      );
      expect(
        document
          .querySelector(".preview-stage-reply")
          ?.getAttribute("aria-hidden"),
      ).toBe("false");
      act(() => vi.advanceTimersByTime(BEAT_MS));
      expect(currentMoment().textContent).toContain(
        COPY.en.journey.stage[2]?.title,
      );
      expect(hero().getByRole("tabpanel").textContent).toContain(
        COPY.en.journey.stageState.after,
      );
      act(() => vi.advanceTimersByTime(BEAT_MS));
      expect(hero().getByRole("tab", { selected: true }).id).toBe(
        "mode-tabletop",
      );
      expect(currentMoment().textContent).toContain(
        COPY.en.journey.tabletop[0]?.title,
      );
      fireEvent.click(
        hero().getByRole("button", { name: /03.*Carry it forward/ }),
      );
      expect(hero().getByRole("tabpanel").textContent).toContain(
        COPY.en.journey.tabletopState.after,
      );
      act(() => vi.advanceTimersByTime(MODE_MS * 2));
      expect(currentMoment().textContent).toContain(
        COPY.en.journey.tabletop[2]?.title,
      );
      for (const mode of COPY.en.hero.modes) {
        fireEvent.click(
          hero().getByRole("tab", { name: mode.word.replace(/\.$/, "") }),
        );
        fireEvent.click(
          hero().getByRole("button", {
            name: new RegExp(COPY.en.journey[mode.visual][2]!.title),
          }),
        );
        const focused = [
          ...screen
            .getByTestId("plugin-rack")
            .querySelectorAll('[data-current="true"]'),
        ].map((node) => node.getAttribute("data-plugin"));
        expect(focused.sort()).toEqual(
          [...MOMENT_PLUGINS[mode.visual][2]!].sort(),
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showcased plugins aligned with world policies and core defaults", () => {
    const root = path.join(import.meta.dirname, "../../../../");
    const read = (file: string) => readFileSync(path.join(root, file), "utf8");
    // These authored fields are plain YAML string sequences. Stop at the next
    // field so recommendations cannot accidentally become default selections.
    const list = (text: string, key: string) => {
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line === `  ${key}:`);
      const result: string[] = [];
      if (start < 0) return result;
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith("    - ")) break;
        result.push(line.slice(6).trim());
      }
      return result;
    };
    const packs = read("packs/builtin.yaml").split(/(?=^- id: )/m);
    for (const mode of COPY.en.hero.modes) {
      const world = read(`worlds/${WORLD_IDS[mode.visual]}/world.yaml`);
      const preset = world.match(/^  preset: (.+)$/m)?.[1];
      const pack = packs.find((entry) => entry.startsWith(`- id: ${preset}\n`));
      expect(pack).toBeTruthy();
      const defaults = PLUGIN_IDS.filter((id) =>
        /^kind: core$/m.test(read(`plugins/${id}/PLUGIN.md`)),
      );
      const selected = new Set([
        ...list(pack!, "requested"),
        ...list(world, "plus"),
        ...defaults,
      ]);
      if (selected.has("chat-mode-narrator")) selected.delete("narrator");
      expect([...PACKS[mode.visual]].sort()).toEqual(
        PLUGIN_IDS.filter((id) => selected.has(id)).sort(),
      );
      for (const group of MOMENT_PLUGINS[mode.visual])
        for (const id of group)
          expect(selected.has(id), `${mode.visual}: ${id}`).toBe(true);
    }
  });

  it("uses editable, localized preview content for every mode and artwork exists", () => {
    window.history.replaceState(null, "", "/?lang=zh");
    const { container } = render(<App />);
    for (const mode of COPY.zh.hero.modes) {
      fireEvent.click(hero().getByRole("tab", { name: mode.word }));
      expect(hero().getByRole("tabpanel").textContent).toContain(
        mode.visual === "stage"
          ? COPY.zh.preview.stage.dialogue
          : mode.visual === "survival"
            ? COPY.zh.preview.survival.narrative
            : COPY.zh.preview[mode.visual].title,
      );
    }
    expect(container.querySelector('img[src*="screens/"]')).toBeNull();
    for (const file of Object.values(PREVIEW_ART)) {
      expect(
        existsSync(path.join(import.meta.dirname, "../../public", file)),
        file,
      ).toBe(true);
    }
  });

  it("supports arrow navigation and pauses automatic rotation on selection", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      fireEvent.keyDown(hero().getByRole("tab", { selected: true }), {
        key: "ArrowRight",
      });
      const selected = hero().getByRole("tab", { selected: true });
      expect(selected.id).toBe("mode-tabletop");
      expect(document.activeElement).toBe(selected);
      act(() => vi.advanceTimersByTime(MODE_MS * 2));
      expect(hero().getByRole("tab", { selected: true })).toBe(selected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cycle content when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.useFakeTimers();
    try {
      render(<App />);
      act(() => vi.advanceTimersByTime(MODE_MS * 3));
      expect(hero().getByRole("tab", { selected: true }).id).toBe("mode-stage");
      expect(
        screen.queryByRole("button", { name: COPY.en.hero.pause }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes mobile navigation on download and pauses while the preview has focus", () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const menu = screen.getByRole("button", { name: COPY.en.nav.menu });
      fireEvent.click(menu);
      const links = screen.getAllByRole("link", {
        name: COPY.en.nav.download,
      });
      const mobileDownload = links.filter((link) => link.closest("nav")).at(-1);
      if (!mobileDownload)
        throw new Error("Expected a download link in mobile navigation");
      fireEvent.click(mobileDownload);
      expect(menu.getAttribute("aria-expanded")).toBe("false");
      const panel = hero().getByRole("tabpanel");
      expect(panel.tabIndex).toBe(0);
      fireEvent.focus(panel);
      act(() => vi.advanceTimersByTime(MODE_MS * 2));
      expect(hero().getByRole("tabpanel")).toBe(panel);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps four play experiences in the carousel and language support in features", () => {
    window.history.replaceState(null, "", "/?lang=zh");
    render(<App />);
    expect(COPY.zh.hero.modes.map((mode) => mode.visual)).toEqual([
      "stage",
      "tabletop",
      "story",
      "survival",
    ]);
    expect(hero().getAllByRole("tab")).toHaveLength(4);
    fireEvent.click(hero().getByRole("tab", { name: "生存沙盒" }));
    expect(
      within(hero().getByRole("tabpanel")).getByRole("heading", {
        name: COPY.zh.preview.survival.chapter,
      }),
    ).toBeTruthy();
    expect(
      within(hero().getByRole("tabpanel")).queryByRole("heading", {
        name: COPY.zh.preview.languages.title,
      }),
    ).toBeNull();
    const features = screen.getByRole("region", {
      name: COPY.zh.worlds.title,
    });
    expect(
      within(features).getByRole("heading", {
        name: COPY.zh.preview.languages.title,
      }),
    ).toBeTruthy();
    expect(PACKS.survival).toContain("inventory");
    expect(PACKS.survival).not.toContain("scene-stage");
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
      plugins: Object.keys(COPY[lang].workbench.tabs),
      links: COPY[lang].pillars.links.map((link) => link.href),
    });
    expect(shape("zh")).toEqual(shape("en"));
  });

  it("only lights up plugins the repository ships", () => {
    const plugins = path.join(import.meta.dirname, "../../../../plugins");
    const named = [...PLUGIN_IDS, ...Object.values(PACKS).flat()];
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
    "Covel-electron-0.0.50-win-x64.zip",
    "SHA256SUMS.txt",
  ].map((name) => ({ name, browser_download_url: `https://dl/${name}` }));

  it("lists both systems even on a phone, and copies a selected file link", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ assets }) }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App />);
    const downloads = within(
      screen.getByRole("region", { name: COPY.en.downloads.title }),
    );
    const buttons = await downloads.findAllByRole("button", {
      name: /Copy link/,
    });
    expect(buttons).toHaveLength(5);
    fireEvent.click(
      downloads.getByRole("button", { name: "Copy link · macOS · Installer" }),
    );
    await downloads.findByText(COPY.en.downloads.copied);
    expect(writeText).toHaveBeenCalledWith(assets[0]?.browser_download_url);
    writeText.mockRejectedValueOnce(new Error("Clipboard blocked"));
    fireEvent.click(
      downloads.getByRole("button", {
        name: "Copy link · Windows · Installer",
      }),
    );
    await downloads.findByText(COPY.en.downloads.copyFailed);
  });

  it("reserves Windows formats without inventing links and enables ZIP when released", () => {
    const current = listDownloads(
      assets.filter(({ name }) => !name.endsWith("-win-x64.zip")),
    );
    const { rerender } = render(
      <Downloads
        copy={COPY.en}
        download={{ href: RELEASES_URL, status: "ready", files: current }}
      />,
    );
    const windows = () =>
      within(
        screen.getByRole("heading", { name: "Windows" }).closest("article")!,
      );
    expect(
      windows().getByText(COPY.en.downloads.installerRecommended).closest("li")
        ?.textContent,
    ).toContain(COPY.en.downloads.installer);
    expect(windows().getByText(COPY.en.downloads.archive)).toBeTruthy();
    expect(windows().getByText(COPY.en.downloads.notPublished)).toBeTruthy();
    expect(
      windows().queryByRole("link", {
        name: `Download · Windows · ${COPY.en.downloads.archive}`,
      }),
    ).toBeNull();
    expect(windows().queryByRole("button", { name: /ZIP/ })).toBeNull();
    expect(windows().getByText(COPY.en.hero.portableHelp)).toBeTruthy();
    rerender(
      <Downloads
        copy={COPY.en}
        download={{
          href: RELEASES_URL,
          status: "ready",
          files: listDownloads(assets),
        }}
      />,
    );
    expect(
      windows()
        .getByRole("link", {
          name: `Download · Windows · ${COPY.en.downloads.archive}`,
        })
        .getAttribute("href"),
    ).toBe(assets[4]?.browser_download_url);
    expect(windows().getByRole("button", { name: /ZIP/ })).toBeTruthy();
    expect(windows().queryByText(COPY.en.downloads.notPublished)).toBeNull();
  });

  it("keeps archive-only releases available and rejects malformed network links", () => {
    expect(
      listDownloads(assets.filter(({ name }) => name.endsWith(".zip"))),
    ).toHaveLength(2);
    expect(
      releaseAssets({
        assets: [
          null,
          { name: "bad", browser_download_url: "javascript:alert(1)" },
          ...assets,
        ],
      }),
    ).toEqual(assets);
    expect(releaseAssets({ assets: "wrong" })).toEqual([]);
  });

  it("always exposes all downloads and an honest release-page fallback", async () => {
    render(<App />);
    await screen.findAllByText(COPY.en.downloads.unavailable);
    expect(document.querySelectorAll("#downloads")).toHaveLength(1);
    expect(document.querySelector("footer section")).toBeNull();
    expect(
      within(document.getElementById("top")!)
        .getByRole("link", { name: COPY.en.hero.primary })
        .getAttribute("href"),
    ).toBe("#downloads");
    expect(
      screen
        .getByRole("link", { name: /All releases & checksums/ })
        .getAttribute("href"),
    ).toBe(RELEASES_URL);
  });

  it("labels a missing platform without hiding the other platform", () => {
    render(
      <Downloads
        copy={COPY.en}
        download={{
          href: RELEASES_URL,
          status: "ready",
          files: listDownloads(assets.slice(0, 2)),
        }}
      />,
    );
    expect(screen.getByText(COPY.en.downloads.missing)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copy link/ })).toHaveLength(
      2,
    );
  });

  it("keeps installers primary and distinguishes both Windows no-install builds", () => {
    expect(pickDownload(assets, "mac")).toEqual({
      href: "https://dl/Covel-electron-0.0.50-mac-arm64.dmg",
      platform: "mac",
    });
    expect(pickDownload(assets, "windows")).toEqual({
      href: "https://dl/Covel-electron-0.0.50-win-x64.exe",
      platform: "windows",
      portable: "https://dl/Covel-electron-0.0.50-win-x64-portable.exe",
      zip: "https://dl/Covel-electron-0.0.50-win-x64.zip",
    });
    expect(pickDownload(assets.slice(0, 2), "windows")).toBeUndefined();
  });

  it.each(["zip", "portable", "both"] as const)(
    "omits missing %s alternatives without borrowing the macOS ZIP",
    (missing) => {
      const available = assets.filter(
        ({ name }) =>
          !(
            (missing !== "portable" && name.endsWith("-win-x64.zip")) ||
            (missing !== "zip" && name.endsWith("-win-x64-portable.exe"))
          ),
      );
      const download = pickDownload(available, "windows");
      expect(download?.href).toBe(
        "https://dl/Covel-electron-0.0.50-win-x64.exe",
      );
      if (!download)
        throw new Error("Fixture must include the Windows installer");
      expect(Boolean(download.zip)).toBe(missing === "portable");
      expect(Boolean(download.portable)).toBe(missing === "zip");
    },
  );

  it("keeps the release-page fallback when the Windows installer is absent", () => {
    const download = pickDownload(
      assets.filter(({ name }) => !name.endsWith("-win-x64.exe")),
      "windows",
    );
    expect(download).toBeUndefined();
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

  it("keeps all file links in one download section and marks the visitor's system", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ assets }) }),
    );
    render(<App />);
    const downloads = within(document.getElementById("downloads")!);
    await downloads.findAllByRole("link", {
      name: /Download · .* · Installer/,
    });
    for (const asset of assets.filter(
      (item) => item.name !== "SHA256SUMS.txt",
    )) {
      const links = document.querySelectorAll(
        `a[href="${asset.browser_download_url}"]`,
      );
      expect(links).toHaveLength(1);
      expect(links[0]?.closest("#downloads")).toBeTruthy();
    }
    expect(
      downloads.getByText(COPY.en.downloads.recommended).closest("article")
        ?.textContent,
    ).toContain("Windows");
  });

  it("tells a macOS visitor how to open the unsigned app", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ assets }) }),
    );
    render(<App />);
    await within(document.getElementById("downloads")!).findAllByRole("link", {
      name: /Download · .* · Installer/,
    });
    expect(
      screen.getAllByText(COPY.en.hero.openHelp.mac.summary).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "xattr -dr com.apple.quarantine /Applications/Covel.app",
      ).length,
    ).toBeGreaterThan(0);
  });
});
