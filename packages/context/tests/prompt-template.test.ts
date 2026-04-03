import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPrompt,
  clearPromptCache,
  interpolate,
} from "../src/template/index.js";

// ── Fixtures ──────────────────────────────────────────────────────

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  clearPromptCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── interpolate ───────────────────────────────────────────────────

describe("interpolate", () => {
  it("should replace single variable", () => {
    expect(interpolate("Hello {{name}}!", { name: "World" })).toBe(
      "Hello World!",
    );
  });

  it("should replace multiple variables", () => {
    const result = interpolate("{{a}} and {{b}}", { a: "X", b: "Y" });
    expect(result).toBe("X and Y");
  });

  it("should replace same variable multiple times", () => {
    const result = interpolate("{{x}} then {{x}}", { x: "ok" });
    expect(result).toBe("ok then ok");
  });

  it("should leave unmatched variables as-is", () => {
    const result = interpolate("{{known}} and {{unknown}}", { known: "yes" });
    expect(result).toBe("yes and {{unknown}}");
  });

  it("should handle empty vars", () => {
    expect(interpolate("no vars here", {})).toBe("no vars here");
  });

  it("should handle multiline templates", () => {
    const tpl = "line1: {{a}}\nline2: {{b}}";
    expect(interpolate(tpl, { a: "1", b: "2" })).toBe("line1: 1\nline2: 2");
  });

  it("should handle empty string variable values", () => {
    expect(interpolate("before{{x}}after", { x: "" })).toBe("beforeafter");
  });
});

// ── loadPrompt ────────────────────────────────────────────────────

describe("loadPrompt", () => {
  it("should load exact locale match (zh)", async () => {
    await writeFile(join(dir, "rules.zh.md"), "中文规则");
    await writeFile(join(dir, "rules.en.md"), "English rules");

    const result = await loadPrompt(dir, "rules", "zh-CN");
    expect(result).toBe("中文规则");
  });

  it("should load exact locale match (en)", async () => {
    await writeFile(join(dir, "rules.zh.md"), "中文规则");
    await writeFile(join(dir, "rules.en.md"), "English rules");

    const result = await loadPrompt(dir, "rules", "en-US");
    expect(result).toBe("English rules");
  });

  it("should fall back to .en.md when locale not found", async () => {
    await writeFile(join(dir, "rules.en.md"), "English fallback");

    const result = await loadPrompt(dir, "rules", "ja-JP");
    expect(result).toBe("English fallback");
  });

  it("should fall back to .md when no locale-specific file exists", async () => {
    await writeFile(join(dir, "rules.md"), "Default content");

    const result = await loadPrompt(dir, "rules", "zh-CN");
    expect(result).toBe("Default content");
  });

  it("should prefer locale-specific over default .md", async () => {
    await writeFile(join(dir, "rules.md"), "Default");
    await writeFile(join(dir, "rules.zh.md"), "Chinese");

    const result = await loadPrompt(dir, "rules", "zh-CN");
    expect(result).toBe("Chinese");
  });

  it("should throw when no file found at all", async () => {
    await expect(
      loadPrompt(dir, "nonexistent", "zh-CN"),
    ).rejects.toThrow();
  });

  it("should cache results across calls", async () => {
    await writeFile(join(dir, "cached.md"), "original");

    const r1 = await loadPrompt(dir, "cached", "en-US");
    // Overwrite file — should still return cached value
    await writeFile(join(dir, "cached.md"), "modified");
    const r2 = await loadPrompt(dir, "cached", "en-US");

    expect(r1).toBe("original");
    expect(r2).toBe("original");
  });

  it("should return fresh content after clearPromptCache", async () => {
    await writeFile(join(dir, "fresh.md"), "v1");
    await loadPrompt(dir, "fresh", "en-US");

    clearPromptCache();
    await writeFile(join(dir, "fresh.md"), "v2");
    const result = await loadPrompt(dir, "fresh", "en-US");
    expect(result).toBe("v2");
  });

  it("should trim trailing whitespace from loaded content", async () => {
    await writeFile(join(dir, "trimmed.md"), "content\n\n");
    const result = await loadPrompt(dir, "trimmed", "en-US");
    expect(result).toBe("content");
  });

  it("should handle locale with region code correctly", async () => {
    await writeFile(join(dir, "test.ko.md"), "Korean");
    const result = await loadPrompt(dir, "test", "ko-KR");
    expect(result).toBe("Korean");
  });
});

// ── Integration ───────────────────────────────────────────────────

describe("loadPrompt + interpolate integration", () => {
  it("should load and interpolate template", async () => {
    await writeFile(
      join(dir, "greeting.zh.md"),
      "你好 {{name}}，欢迎来到 {{world}}！",
    );

    const template = await loadPrompt(dir, "greeting", "zh-CN");
    const result = interpolate(template, { name: "玩家", world: "雾港" });
    expect(result).toBe("你好 玩家，欢迎来到 雾港！");
  });
});
