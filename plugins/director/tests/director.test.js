import { describe, it, expect } from "vitest";
import injectPreamble from "../hooks/inject-preamble.js";
import { PREAMBLE, PREAMBLE_ZH } from "../hooks/_preamble.js";
import handler from "../handler.js";

const CTX = { sessionId: "sess-director-1" };

describe("director / inject-preamble (PostContextAssembly)", () => {
  it("appends the preamble to the story runtime's system prompt", async () => {
    const r = await injectPreamble(CTX, {
      outputKind: "story",
      systemPrompt: "BASE_SYSTEM_PROMPT",
    });
    expect(r.action).toBe("continue");
    expect(r.replace.systemPrompt).toBe(
      "BASE_SYSTEM_PROMPT" + "\n\n" + PREAMBLE,
    );
  });

  it("localizes the preamble to the payload locale (zh-CN → Chinese note)", async () => {
    const r = await injectPreamble(CTX, {
      outputKind: "story",
      systemPrompt: "BASE",
      locale: "zh-CN",
    });
    expect(r.replace.systemPrompt).toBe("BASE" + "\n\n" + PREAMBLE_ZH);
  });

  it("preserves the original prompt verbatim as the prefix", async () => {
    const base = "You are the narrator.\nFollow the world canon.";
    const r = await injectPreamble(CTX, {
      outputKind: "story",
      systemPrompt: base,
    });
    expect(r.replace.systemPrompt.startsWith(base + "\n\n")).toBe(true);
    expect(r.replace.systemPrompt.endsWith(PREAMBLE)).toBe(true);
  });

  it("leaves plugin-kind runtimes untouched (no replace)", async () => {
    const r = await injectPreamble(CTX, {
      outputKind: "plugin",
      systemPrompt: "CODEX_PROMPT",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("leaves system-kind runtimes untouched (no replace)", async () => {
    const r = await injectPreamble(CTX, {
      outputKind: "system",
      systemPrompt: "SYSTEM_PROMPT",
    });
    expect(r).toEqual({ action: "continue" });
  });

  it("treats a missing outputKind as non-story (no replace)", async () => {
    const r = await injectPreamble(CTX, { systemPrompt: "UNKNOWN_PROMPT" });
    expect(r).toEqual({ action: "continue" });
  });

  it("does not throw when the payload is absent", async () => {
    const r = await injectPreamble(CTX, undefined);
    expect(r).toEqual({ action: "continue" });
  });
});

describe("director / handler (manual function runtime is a no-op)", () => {
  it("returns an empty object and never schedules", async () => {
    expect(await handler()).toEqual({});
  });
});
