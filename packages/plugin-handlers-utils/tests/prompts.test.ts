import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPromptLoader } from "../src/prompts.js";

describe("createPromptLoader", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-sdk-prompts-"));
    await mkdir(path.join(root, "server"));
    for (const [file, text] of [
      ["x.md", "english"],
      ["x.zh.md", "中文"],
      ["x.ru.md", "русский"],
      ["x.en-US.md", "american"],
      ["y.md", "only english"],
    ])
      await writeFile(path.join(root, "server", file!), text!);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads only the English file and the Simplified Chinese variant", async () => {
    const load = createPromptLoader(root);
    expect(await load("server", "x", "zh-CN")).toBe("中文");
    expect(await load("server", "x", "zh-Hans-SG")).toBe("中文");
    expect(await load("server", "x", "ru-RU")).toBe("english");
    expect(await load("server", "x", "en-US")).toBe("english");
    expect(await load("server", "x", "zh-TW")).toBe("english");
    expect(await load("server", "x")).toBe("english");
    expect(await load("server", "y", "zh-CN")).toBe("only english");
  });

  it("follows COVEL_INSTRUCTION_LOCALE", async () => {
    const load = createPromptLoader(root);
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    try {
      expect(await load("server", "x", "zh-CN")).toBe("english");
      vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "zh");
      expect(await load("server", "x", "ru-RU")).toBe("中文");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a path-like locale and names the files it tried", async () => {
    const load = createPromptLoader(root);
    await expect(load("server", "x", "x/../../README")).rejects.toThrow(
      "Invalid locale",
    );
    await expect(load("server", "missing", "zh-CN")).rejects.toThrow(
      /missing\.zh-CN\.md[\s\S]*missing\.zh\.md[\s\S]*missing\.md/,
    );
  });
});
