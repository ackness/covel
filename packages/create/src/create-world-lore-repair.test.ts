import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
import { createWorld } from "./create-world.js";

const WORLD_YAML = `schemaVersion: "1.0"
id: repair-world
name: 修复世界
version: "0.1.0"
summary: 一个用于验证定向修复流程的世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [repair]
requiredPlugins: []
recommendedPlugins: []`;

const CLEAN_LORE = `# 修复世界

钟楼在雨夜提前敲响，所有街区必须在下一声钟响前选择阵营。

1. 追踪逆行的钟声。
2. 保护唯一清醒的证人。
3. 在黎明前封锁中央钟楼。`;

const META_LORE = `# 修复世界

这是一个低成本快速验证用的世界。

1. 追踪逆行的钟声。
2. 保护唯一清醒的证人。
3. 在黎明前封锁中央钟楼。`;

const INVALID_STRUCTURE_LORE = `# 修复世界

钟楼在雨夜提前敲响。

1. 追踪逆行的钟声。
2. 保护唯一清醒的证人。`;

type LlmRequest = Parameters<LLMAdapter["generate"]>[0];

class RecordingSequenceLlm implements LLMAdapter {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly contents: readonly string[]) {}

  async generate(params: LlmRequest): Promise<LLMResponse> {
    const content =
      this.contents[Math.min(this.requests.length, this.contents.length - 1)]!;
    this.requests.push(params);
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function fullPackage(lore: string): string {
  return `===WORLD_YAML===\n${WORLD_YAML}\n===WORLD_MD===\n${lore}\n===END===`;
}

function loreRepair(lore: string): string {
  return `===WORLD_MD===\n${lore}\n===END===`;
}

function messageText(request: LlmRequest, index: number): string {
  const content = request.messages[index]?.content;
  if (typeof content !== "string") throw new Error("Expected a text message");
  return content;
}

describe("createWorld WORLD.md repair", () => {
  let outputDir = "";

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), "covel-lore-repair-"));
  });

  afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
  });

  it("repairs explicit meta wording without regenerating the package", async () => {
    const llm = new RecordingSequenceLlm([
      fullPackage(META_LORE),
      loreRepair(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      outputDir,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(messageText(llm.requests[1]!, 0)).toContain(
      "without changing the rest of its world package",
    );
    expect(messageText(llm.requests[1]!, 1)).toContain(META_LORE);
    expect(messageText(llm.requests[1]!, 1)).not.toContain("WORLD_YAML");
    expect(llm.requests[1]!.signal).toBe(llm.requests[0]!.signal);
    await expect(
      readFile(path.join(outputDir, "repair-world", "WORLD.md"), "utf8"),
    ).resolves.toBe(CLEAN_LORE);
    await expect(
      readFile(path.join(outputDir, "repair-world", "world.yaml"), "utf8"),
    ).resolves.toContain("id: repair-world");
  });

  it("falls back to full generation when the targeted response is invalid", async () => {
    const llm = new RecordingSequenceLlm([
      fullPackage(META_LORE),
      fullPackage(CLEAN_LORE),
      fullPackage(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      outputDir,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(llm.requests).toHaveLength(3);
    expect(messageText(llm.requests[2]!, 1)).toContain(
      "Regenerate the full package now",
    );
    expect(messageText(llm.requests[2]!, 1)).toContain(
      "WORLD.md contains explicit generation meta wording",
    );
    expect(llm.requests[2]!.signal).not.toBe(llm.requests[0]!.signal);
  });

  it("does not make a repair request for valid lore", async () => {
    const llm = new RecordingSequenceLlm([fullPackage(CLEAN_LORE)]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      outputDir,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it("uses full generation for structural lore errors", async () => {
    const llm = new RecordingSequenceLlm([
      fullPackage(INVALID_STRUCTURE_LORE),
      fullPackage(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      outputDir,
      attemptTimeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(messageText(llm.requests[1]!, 1)).toContain(
      "Regenerate the full package now",
    );
  });
});
