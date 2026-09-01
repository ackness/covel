import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setPromptsRoot } from "@covel/context";
import { buildWorldPrompt } from "./prompts.js";

describe("world creation locale", () => {
  let temporaryPromptsRoot: string | undefined;

  afterEach(async () => {
    setPromptsRoot(null);
    if (temporaryPromptsRoot) {
      await rm(temporaryPromptsRoot, { recursive: true, force: true });
      temporaryPromptsRoot = undefined;
    }
  });

  it("canonicalizes extended locale tags without collapsing their script", async () => {
    const prompt = await buildWorldPrompt("雨中的城市", "zh_hant_tw");

    expect(prompt).toContain("zh-Hant-TW");
    expect(prompt).toContain("中文（繁體，台灣）");
    expect(prompt).not.toContain("简体中文");
  });

  it("falls back safely when a caller supplies a path-like locale", async () => {
    const prompt = await buildWorldPrompt("Safe world", "x/../../../README");

    expect(prompt).toContain("zh-CN");
    expect(prompt).not.toContain("../../../README");
  });

  it("loads an exact-locale framework prompt when one is provided", async () => {
    temporaryPromptsRoot = await mkdtemp(
      path.join(tmpdir(), "covel-create-prompts-"),
    );
    const serverPrompts = path.join(temporaryPromptsRoot, "server");
    await mkdir(serverPrompts);
    await writeFile(
      path.join(serverPrompts, "generate-world.ru-RU.md"),
      "RU TEMPLATE: {{ concept }} / {{ locale }} / {{ language }}",
      "utf8",
    );
    setPromptsRoot(temporaryPromptsRoot);

    const prompt = await buildWorldPrompt("Город под дождём", "ru_ru");

    expect(prompt).toContain("RU TEMPLATE: Город под дождём / ru-RU / Русский");
  });
});
