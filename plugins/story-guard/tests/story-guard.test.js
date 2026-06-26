import { describe, it, expect, afterEach } from "vitest";
import sanitizeResponse from "../hooks/sanitize-response.js";
import guardTool from "../hooks/guard-tool.js";
import { sanitize, stripMenuLines, isBlockedTool } from "../hooks/_rules.js";

const CTX = { event: "test", sessionId: "s", turnId: "t" };

/** Build a full LLMResponse so we can assert non-content fields survive. */
function makeResponse(content) {
  return {
    content,
    toolCalls: [{ id: "tc-1", name: "look", arguments: "{}" }],
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 7 },
    reasoningContent: "thinking…",
  };
}

const ENV_KEYS = [
  "STORY_GUARD_REDACT_TERMS",
  "STORY_GUARD_REDACT_MARK",
  "STORY_GUARD_BLOCKED_TOOLS",
];

describe("story-guard rules: red-line redaction", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("strips AI/model self-identification boilerplate (EN)", () => {
    const out = sanitize("As an AI language model, you push the heavy door.");
    expect(out).toBe("you push the heavy door.");
  });

  it("strips AI/model self-identification boilerplate (ZH)", () => {
    const out = sanitize("作为一个AI助手，我看到门后是一条走廊。");
    expect(out).toBe("我看到门后是一条走廊。");
  });

  it("strips llama prompt-template artifacts", () => {
    const out = sanitize("门吱呀打开。[INST] 内部指令 [/INST] 你走了进去。");
    expect(out).toBe("门吱呀打开。内部指令你走了进去。");
  });

  it("does not touch ordinary uses of 'AI' or '模型' in prose", () => {
    const prose = "这台老旧的 AI 终端嗡嗡作响，模型的轮廓在屏幕上闪烁。";
    expect(sanitize(prose)).toBe(prose);
  });

  it("redacts deployment-configured banned terms to the marker", () => {
    process.env.STORY_GUARD_REDACT_TERMS = "forbidden, secretword";
    process.env.STORY_GUARD_REDACT_MARK = "[blocked]";
    const out = sanitize("The Forbidden tome hides a SECRETWORD inside.");
    expect(out).toBe("The [blocked] tome hides a [blocked] inside.");
  });

  it("uses the default marker when none is configured", () => {
    process.env.STORY_GUARD_REDACT_TERMS = "zalgo";
    expect(sanitize("A zalgo glyph glows.")).toBe("A [redacted] glyph glows.");
  });
});

describe("story-guard rules: menu stripping", () => {
  it("strips lettered, numbered, CJK and parenthesised option lines", () => {
    const text = [
      "你站在岔路口。",
      "A) 向左走",
      "1. 向右走",
      "B、原地等待",
      "(C) 返回",
      "（3）呼喊同伴",
    ].join("\n");
    expect(stripMenuLines(text)).toBe("你站在岔路口。");
  });

  it("strips explicit menu headers that end in a colon", () => {
    const text = "你站在岔路口。\n你的选择是：\nOptions:";
    expect(stripMenuLines(text)).toBe("你站在岔路口。");
  });

  it("does not strip decimals or free-form questions", () => {
    const text = "你掂量着 1.5 公斤的火药。\n你想做什么？";
    expect(stripMenuLines(text)).toBe(text);
  });

  it("leaves plain narrative untouched (identical reference)", () => {
    const text = "夜风穿过废墟，远处传来钟声。";
    expect(stripMenuLines(text)).toBe(text);
    expect(sanitize(text)).toBe(text);
  });
});

describe("story-guard PostLLMResponse: sanitize-response", () => {
  it("returns continue (no replace) when content is an empty string", async () => {
    const r = await sanitizeResponse(CTX, { response: makeResponse("") });
    expect(r).toEqual({ action: "continue" });
  });

  it("returns continue (no replace) when content is not a string", async () => {
    const r = await sanitizeResponse(CTX, { response: makeResponse(null) });
    expect(r).toEqual({ action: "continue" });
  });

  it("returns continue (no replace) when there is nothing to sanitise", async () => {
    const r = await sanitizeResponse(CTX, {
      response: makeResponse("一切如常，没有红线词也没有菜单。"),
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("returns continue (no replace) when sanitising would blank the content", async () => {
    // Pure menu → stripped to empty → conservative: never blank the narrative.
    const pureMenu = "你的选择是：\nA) 留下\nB) 离开";
    const r = await sanitizeResponse(CTX, { response: makeResponse(pureMenu) });
    expect(r).toEqual({ action: "continue" });
  });

  it("rewrites via replace.response and preserves the full response shape", async () => {
    const dirty = "作为AI助手，你推开门。\n你的选择是：\nA) 前进\nB) 后退";
    const original = makeResponse(dirty);
    const r = await sanitizeResponse(CTX, { response: original });

    expect(r.action).toBe("continue");
    expect(r.replace).toBeDefined();
    const next = r.replace.response;

    // Content is sanitised…
    expect(next.content).toBe("你推开门。");
    // …and every other field is carried back verbatim.
    expect(next.toolCalls).toBe(original.toolCalls);
    expect(next.finishReason).toBe("stop");
    expect(next.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(next.reasoningContent).toBe("thinking…");
    // Original response object is not mutated.
    expect(original.content).toBe(dirty);
  });

  it("tolerates a missing response payload", async () => {
    expect(await sanitizeResponse(CTX, {})).toEqual({ action: "continue" });
  });
});

describe("story-guard PreToolUse: guard-tool", () => {
  afterEach(() => {
    delete process.env.STORY_GUARD_BLOCKED_TOOLS;
  });

  it("aborts a built-in high-risk tool with a reason", async () => {
    const r = await guardTool(CTX, {
      toolCall: { id: "x", name: "delete-everything", arguments: "{}" },
    });
    expect(r.action).toBe("abort");
    expect(r.reason).toMatch(/delete-everything/);
    expect(r.reason).toMatch(/blocked/i);
  });

  it("matches the deny-list case-insensitively", async () => {
    const r = await guardTool(CTX, {
      toolCall: { id: "x", name: "Drop-Database", arguments: "{}" },
    });
    expect(r.action).toBe("abort");
  });

  it("aborts an env-configured extra tool", async () => {
    process.env.STORY_GUARD_BLOCKED_TOOLS = "nuke-save, format-disk";
    const r = await guardTool(CTX, {
      toolCall: { id: "x", name: "nuke-save", arguments: "{}" },
    });
    expect(r.action).toBe("abort");
  });

  it("continues for ordinary tools", async () => {
    const r = await guardTool(CTX, {
      toolCall: { id: "x", name: "create-character", arguments: "{}" },
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("continues when the tool name is missing or non-string", async () => {
    expect(await guardTool(CTX, { toolCall: {} })).toEqual({
      action: "continue",
    });
    expect(await guardTool(CTX, {})).toEqual({ action: "continue" });
    expect(isBlockedTool(undefined)).toBe(false);
  });
});
