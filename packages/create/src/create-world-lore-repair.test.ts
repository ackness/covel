import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
import { createWorld } from "./create-world.js";
import { createPromptLoader } from "@covel/context";

const WORLD_YAML = `schemaVersion: "1.0"
id: repair-world
name: 修复世界
version: "0.1.0"
summary: 一个用于验证定向修复流程的世界。
defaultLocale: zh-CN
supportedLocales: [zh-CN]
tags: [repair]
pluginPolicy:
  requested: []
  recommended: []`;

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
    // The manifest, then the lore, then the repair of the lore.
    const llm = new RecordingSequenceLlm([
      fullPackage(META_LORE),
      fullPackage(META_LORE),
      loreRepair(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(llm.requests).toHaveLength(3);
    expect(messageText(llm.requests[2]!, 0)).toContain(
      "without changing the rest of its world package",
    );
    expect(messageText(llm.requests[2]!, 1)).toContain(META_LORE);
    expect(messageText(llm.requests[2]!, 1)).not.toContain("WORLD_YAML");
    if (!result.success) throw new Error(result.errors.join("; "));
    expect(result.lore).toBe(CLEAN_LORE);
    expect(result.manifest.id).toBe("repair-world");
  });

  it("propagates caller cancellation during targeted lore repair", async () => {
    const controller = new AbortController();
    const reason = new Error("caller canceled targeted repair");
    let calls = 0;
    const llm: LLMAdapter = {
      async generate() {
        calls++;
        if (calls <= 2) {
          return {
            content: fullPackage(META_LORE),
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        controller.abort(reason);
        throw new Error("repair provider failed");
      },
    };

    await expect(
      createWorld({
        llm,
        concept: "修复世界",
        signal: controller.signal,
        idleTimeoutMs: 5_000,
      }),
    ).rejects.toBe(reason);
    expect(calls).toBe(3);
    await expect(
      readFile(path.join(outputDir, "repair-world", "WORLD.md")),
    ).rejects.toThrow();
  });

  it("does not ask for the lore again when the repair request stays silent", async () => {
    let calls = 0;
    const llm: LLMAdapter = {
      async generate({ signal }) {
        calls++;
        if (calls <= 2) {
          return {
            content: fullPackage(META_LORE),
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        return new Promise<LLMResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };

    const result = await createWorld({
      llm,
      concept: "修复世界",
      idleTimeoutMs: 5,
    });
    expect(result).toMatchObject({ success: false, idleTimeout: true });
    // The manifest, the lore, and one repair request that got no answer.
    expect(calls).toBe(3);
  });

  it("keeps concurrent template sources isolated through repair and retry", async () => {
    await Promise.all(
      ["first", "second"].map(async (owner) => {
        const root = path.join(outputDir, owner, "prompts");
        await mkdir(path.join(root, "server"), { recursive: true });
        await writeFile(
          path.join(root, "server", "generate-world.md"),
          `${owner} generation: {{ concept }}`,
          "utf8",
        );
        await writeFile(
          path.join(root, "server", "repair-world-lore.md"),
          `${owner} repair: {{ locale }}`,
          "utf8",
        );
        const llm = new RecordingSequenceLlm([
          fullPackage(META_LORE),
          fullPackage(META_LORE),
          "invalid repair output",
          fullPackage(META_LORE),
          loreRepair(CLEAN_LORE),
        ]);
        const result = await createWorld({
          llm,
          concept: owner,
          loadPrompt: createPromptLoader(root),
          idleTimeoutMs: 5_000,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        expect(llm.requests).toHaveLength(5);
        expect(llm.requests.map((request) => messageText(request, 0))).toEqual([
          `${owner} generation: ${owner}`,
          `${owner} generation: ${owner}`,
          `${owner} repair: zh-CN`,
          `${owner} generation: ${owner}`,
          `${owner} repair: zh-CN`,
        ]);
        if (!result.success) throw new Error(result.errors.join("; "));
        expect(result.lore).toBe(CLEAN_LORE);
      }),
    );
  });

  it("asks for the lore again when the targeted response is invalid", async () => {
    const llm = new RecordingSequenceLlm([
      fullPackage(META_LORE),
      fullPackage(META_LORE),
      fullPackage(CLEAN_LORE),
      fullPackage(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(llm.requests).toHaveLength(4);
    // The manifest is written; only the lore is asked for again.
    expect(messageText(llm.requests[3]!, 1)).toContain(
      "Write one part of the world package now: WORLD_MD.",
    );
    expect(messageText(llm.requests[3]!, 3)).toContain("Write this part again");
    expect(messageText(llm.requests[3]!, 3)).toContain(
      "WORLD.md contains explicit generation meta wording",
    );
  });

  it("does not make a repair request for valid lore", async () => {
    const llm = new RecordingSequenceLlm([fullPackage(CLEAN_LORE)]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(llm.requests).toHaveLength(2);
  });

  it("asks for the lore again alone after a structural lore error", async () => {
    const llm = new RecordingSequenceLlm([
      fullPackage(INVALID_STRUCTURE_LORE),
      fullPackage(INVALID_STRUCTURE_LORE),
      fullPackage(CLEAN_LORE),
    ]);

    const result = await createWorld({
      llm,
      concept: "修复世界",
      idleTimeoutMs: 5_000,
    });

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(llm.requests).toHaveLength(3);
    expect(messageText(llm.requests[2]!, 1)).toContain(
      "Write one part of the world package now: WORLD_MD.",
    );
    expect(messageText(llm.requests[2]!, 3)).toContain("Write this part again");
  });
});
