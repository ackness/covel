import { expect, it } from "vitest";
import { buildContextSync as buildContext } from "../src/context-builder.js";
import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  type PromptSegment,
} from "@covel/shared";
const segment = (
  id: string,
  extra: Partial<PromptSegment> = {},
): PromptSegment => ({
  id,
  content: id,
  position: "system",
  audience: "all",
  volatility: "turn",
  providerPluginId: "source",
  ...extra,
});
function assemble(segments: readonly PromptSegment[]) {
  return buildContext({
    promptTemplate: "Instructions",
    manifest: {
      name: "target",
      pluginId: "target",
      description: "Test",
      stage: "narrative",
      outputKind: "story",
      outputContract: "example@1",
    },
    turnInput: {
      sessionId: "s",
      turnId: "t",
      origin: "player",
      playerMessage: "hello",
    },
    completedResults: new Map(),
    promptSegments: segments,
  });
}
it("keeps stable and session system segments in the system prompt and moves turn-volatile ones out", () => {
  const { systemPrompt, turnContext, messages } = assemble([
    segment("fresh memory"),
    segment("static", { volatility: "stable" }),
    segment("session", { volatility: "session" }),
  ]);
  expect(systemPrompt.indexOf("static")).toBeLessThan(
    systemPrompt.indexOf("session"),
  );
  expect(systemPrompt).not.toContain("fresh memory");
  expect(turnContext).toBe("fresh memory");
  expect(messages).toEqual([
    { role: "system", content: "fresh memory" },
    { role: "user", content: "hello" },
  ]);
});
it("scopes segments to their provider, story runtimes and declared contracts", () => {
  const { turnContext } = assemble([
    segment("private", { audience: "self" }),
    segment("own", { audience: "self", providerPluginId: "target" }),
    segment("story", { audience: "story" }),
    segment("matching", { audience: { contract: "example@1" } }),
    segment("unrelated", { audience: { contract: "other@1" } }),
  ]);
  expect(turnContext).not.toContain("private");
  expect(turnContext).not.toContain("unrelated");
  expect(turnContext).toContain("own");
  expect(turnContext).toContain("story");
  expect(turnContext).toContain("matching");
});
it("keeps message roles and post-history placement", () => {
  const { messages } = assemble([
    segment("before", { position: "pre-history", role: "user" }),
    segment("after", { position: "post-history", role: "assistant" }),
  ]);
  expect(messages[0]).toEqual({ role: "user", content: "before" });
  expect(messages.at(-1)).toEqual({ role: "assistant", content: "after" });
});

it("places depth segments before the requested history position and post-history last", () => {
  const result = buildContext({
    promptTemplate: "Instructions",
    manifest: {
      name: "target",
      pluginId: "target",
      description: "Test",
      stage: "narrative",
    },
    turnInput: {
      sessionId: "s",
      turnId: "t",
      origin: "player",
      playerMessage: "current",
    },
    completedResults: new Map(),
    messageHistory: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
    promptSegments: [
      segment("depth", { position: { depth: 1 }, role: "user" }),
      segment("last", { position: "post-history" }),
    ],
  });
  expect(result.messages.map(({ content }) => content)).toEqual([
    "u1",
    "a1",
    "u2",
    "depth",
    "current",
    "last",
  ]);
  expect(result.messages[3]?.role).toBe("user");
});
it("keeps provider content literal instead of interpolating caller template syntax", () => {
  expect(
    assemble([
      segment("literal", {
        content: "{{ player.message }}",
        position: "post-history",
      }),
    ]).messages.at(-1)?.content,
  ).toBe("{{ player.message }}");
});
it("clamps depth beyond the available history and supports depth zero", () => {
  const result = assemble([
    segment("first", { position: { depth: 99 } }),
    segment("last", { position: { depth: 0 } }),
  ]);
  expect(result.messages.map(({ content }) => content)).toEqual([
    "first",
    "hello",
    "last",
  ]);
});

it("breaks same-order provider ties by code units, not locale", () => {
  // localeCompare ranks "alpha" before "Zeta"; code-unit order puts "Zeta"
  // first. Both must agree with the extension host's provider ordering so
  // assembled bytes stay identical across ICU builds.
  const { turnContext } = assemble([
    segment("from-alpha", { providerPluginId: "alpha" }),
    segment("from-zeta", { providerPluginId: "Zeta" }),
  ]);
  expect(turnContext.indexOf("from-zeta")).toBeGreaterThanOrEqual(0);
  expect(turnContext.indexOf("from-zeta")).toBeLessThan(
    turnContext.indexOf("from-alpha"),
  );
});

it("keeps mixed message positions while moving volatile system-role content past system cache markers", () => {
  const { systemPrompt, messages } = assemble([
    segment("fresh-system", { position: "pre-history", role: "system" }),
    segment("stable-system", {
      position: "pre-history",
      role: "system",
      volatility: "stable",
    }),
    segment("early-user", { position: "pre-history", role: "user" }),
    segment("deep-assistant", {
      position: { depth: 0 },
      role: "assistant",
      volatility: "session",
    }),
    segment("late-user", {
      position: "post-history",
      role: "user",
      volatility: "stable",
    }),
  ]);
  const boundary = systemPrompt.lastIndexOf(PROMPT_CACHE_BREAKPOINT_MARKER);
  expect(systemPrompt.indexOf("stable-system")).toBeLessThan(boundary);
  expect(systemPrompt.indexOf("fresh-system")).toBeGreaterThan(boundary);
  expect(messages).toEqual([
    { role: "user", content: "early-user" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "deep-assistant" },
    { role: "user", content: "late-user" },
  ]);
});
