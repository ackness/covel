import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { THEME_SCHEME_KEY } from "@/lib/appearance.js";
import { primeThemeRegistry } from "../registry.js";
import { APPEARANCE_TOKENS_KEY } from "../overrides.js";
import {
  buildThemeCss,
  ensureThemeId,
  slugifyThemeId,
} from "../theme-export.js";
import { parseImportedThemeFile } from "../validate.js";
import { resolveActivity } from "@/hooks/use-document-session-state.js";

// Read from disk rather than `?raw`: vitest does not process CSS assets, so
// the import that `builtins.ts` uses resolves to an empty string under test.
const auroraCss = readFileSync(
  resolve(process.cwd(), "src/themes/builtins/aurora/theme.css"),
  "utf8",
);

class MemorySettingsAdapter implements SettingsBackendAdapter {
  private entries: Record<string, unknown> = {};
  private secrets: Record<string, string> = {};
  async load(): Promise<Record<string, unknown>> {
    return { ...this.entries };
  }
  async save(entries: Record<string, unknown>): Promise<void> {
    this.entries = { ...entries };
  }
  async loadSecrets(): Promise<Record<string, string>> {
    return { ...this.secrets };
  }
  async saveSecrets(keys: Record<string, string>): Promise<void> {
    this.secrets = { ...keys };
  }
}

async function createStore() {
  const store = new SettingsStore(new MemorySettingsAdapter());
  await store.init();
  primeThemeRegistry(store);
  await store.set(THEME_SCHEME_KEY, "dark");
  return store;
}

describe("theme id derivation", () => {
  it("slugifies a latin name", () => {
    expect(slugifyThemeId("My Cozy Theme")).toBe("my-cozy-theme");
    expect(slugifyThemeId("  Neon__Drift!! ")).toBe("neon-drift");
  });

  it("gives names that slugify to nothing a name-derived id", () => {
    // CJK names are common here and carry no latin characters at all.
    const id = slugifyThemeId("我的主题");
    expect(id).toMatch(/^custom-theme-[a-z0-9]+$/);
    // Stable: re-saving the same name must update that theme, not add another.
    expect(slugifyThemeId("我的主题")).toBe(id);
    expect(slugifyThemeId("  我的主题  ")).toBe(id);
  });

  it("never gives two different non-latin names the same id", () => {
    // Regression: a shared constant fallback made every Chinese-named theme
    // collide, and saveCustomTheme de-duplicates by id — so saving a second
    // one silently deleted the first.
    const names = ["我的极光", "我的纸本", "夜读模式", "深色护眼", "ダーク"];
    const ids = names.map(slugifyThemeId);
    expect(new Set(ids).size).toBe(names.length);
  });

  it("never lands on a builtin id", () => {
    // A custom theme claiming a builtin id is silently dropped on the next
    // registry sync, so saving one would appear to work and then vanish.
    expect(ensureThemeId("paper", ["paper", "modern"])).toBe("paper-2");
    expect(ensureThemeId("paper", ["paper", "paper-2"])).toBe("paper-3");
    expect(ensureThemeId("mine", ["paper"])).toBe("mine");
  });
});

describe("buildThemeCss", () => {
  it("scopes every block to the requested theme id", async () => {
    const store = await createStore();
    const { cssText } = buildThemeCss(store, "my-theme");

    expect(cssText).toContain('html[data-theme="my-theme"] {');
    // No stray selector may escape the theme's own scope.
    for (const selector of cssText.matchAll(/^([^@\s][^{]*)\{/gm)) {
      expect(selector[1]).toContain('[data-theme="my-theme"]');
    }
  });

  it("bakes the player's overrides into the output", async () => {
    const store = await createStore();
    await store.set(APPEARANCE_TOKENS_KEY, {
      shared: { "--story-font-size": "1.375rem" },
      light: {},
      dark: { "--color-background": "#101014" },
    });

    const { cssText } = buildThemeCss(store, "my-theme");
    expect(cssText).toContain("--story-font-size: 1.375rem;");
    expect(cssText).toContain("--color-background: #101014;");
  });

  it("keeps a dark-only source from being labelled light-only", async () => {
    const store = await createStore();
    // Both schemes snapshot identically for a single-scheme theme, so the
    // empty delta must not be read as "this is a light theme" — that would
    // drop the `.dark` class and kill every Tailwind `dark:` variant.
    expect(buildThemeCss(store, "my-theme", ["dark"]).schemes).toEqual([
      "dark",
    ]);
    expect(buildThemeCss(store, "my-theme").schemes).toEqual(["light"]);
  });

  it("drops values that could break out of the generated rule", async () => {
    const store = await createStore();
    await store.set(APPEARANCE_TOKENS_KEY, {
      shared: {
        // The generated CSS is re-parsed as a theme, so a value carrying `;`
        // or a brace could close the rule early and escape the scope.
        "--story-font-size": "1rem; } html * { display: none",
        "--story-line-height": "1.8",
      },
      light: {},
      dark: {},
    });

    const { cssText } = buildThemeCss(store, "my-theme");
    expect(cssText).not.toContain("display: none");
    expect(cssText).toContain("--story-line-height: 1.8;");
  });
});

describe("aurora reference theme", () => {
  it("passes the same import validation a player's theme would", () => {
    // It is documented as a copyable template, so it has to survive the
    // scope/at-rule checks that a hand-written theme goes through.
    expect(() => parseImportedThemeFile(auroraCss, "aurora.css")).not.toThrow();
  });

  it("uses the turn-state hook the framework publishes", () => {
    expect(auroraCss).toContain('[data-turn="executing"]');
    expect(auroraCss).toContain("@property --aurora-angle");
    expect(auroraCss).toContain("prefers-reduced-motion");
  });
});

describe("turn activity", () => {
  it("reports the state worth styling", () => {
    expect(resolveActivity(false, null, 0)).toBe("idle");
    expect(resolveActivity(true, null, 0)).toBe("executing");
    // A suspension outranks `executing`: the turn is open but blocked on the
    // player, which is the state a theme wants to highlight.
    expect(resolveActivity(true, null, 1)).toBe("waiting");
    expect(resolveActivity(true, "boom", 1)).toBe("error");
  });
});
