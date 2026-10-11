import { existsSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { COPY, LANGS } from "../copy.js";

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
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
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
      COPY.zh.hero.titleA,
    );
    expect(document.documentElement.lang).toBe("zh-CN");

    fireEvent.click(
      screen.getByRole("button", { name: COPY.zh.nav.languageLabel }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      COPY.en.hero.titleA,
    );
    expect(window.localStorage.getItem("covel-site:lang")).toBe("en");
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

  it("lists the same worlds, steps and features in both languages", () => {
    const shape = (lang: (typeof LANGS)[number]) => ({
      worlds: COPY[lang].worlds.list.map((world) => world.id),
      steps: COPY[lang].play.steps.length,
      features: COPY[lang].features.items.length,
      links: COPY[lang].creators.links.map((link) => link.href),
    });
    expect(shape("zh")).toEqual(shape("en"));
  });
});
