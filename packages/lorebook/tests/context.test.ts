import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TokenEstimator } from "@covel/context";
import {
  createLorebookFromRegistry,
  createLorebookFromWorld,
  LorebookRegistry,
} from "../src/index.js";
import type { LorebookEntry } from "../src/types.js";

const charEstimator: TokenEstimator = (text: string) =>
  text.replace(/\s+/g, "").length;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORLD_A = path.join(HERE, "fixtures", "world-a");

describe("createLorebookFromWorld", () => {
  it("builds a working context from a world lorebook directory", async () => {
    const ctx = await createLorebookFromWorld(WORLD_A);

    // The constant world-overview entry should fire even without messages.
    const result = ctx.applyLorebook({
      messages: [{ role: "user", content: "random chatter" }],
      budget: { maxTokens: 10_000, estimator: charEstimator },
    });

    const beforeCharDefs = result.entriesByPosition.get("before_char_defs") ?? [];
    const afterCharDefs = result.entriesByPosition.get("after_char_defs") ?? [];
    expect(beforeCharDefs.map(e => e.id)).toEqual(["world-overview"]);
    // No selective keys matched, so no selective entries should appear.
    expect(afterCharDefs.some(e => e.id === "qingping-sect")).toBe(false);
    expect(afterCharDefs.some(e => e.id === "su-wan")).toBe(false);
  });

  it("fires the Qingping selective when the keyword is in the recent message", async () => {
    const ctx = await createLorebookFromWorld(WORLD_A);
    const result = ctx.applyLorebook({
      messages: [{ role: "user", content: "I want to talk to 青萍宗 elders" }],
      budget: { maxTokens: 10_000, estimator: charEstimator },
    });
    const afterCharDefs = result.entriesByPosition.get("after_char_defs") ?? [];
    expect(afterCharDefs.map(e => e.id)).toContain("qingping-sect");
  });
});

describe("createLorebookFromRegistry", () => {
  it("respects layered precedence when applying lorebook at runtime", () => {
    const registry = new LorebookRegistry();

    const worldEntry: LorebookEntry = {
      id: "shared",
      source: "world",
      keys: [],
      selectiveLogic: "and_any",
      content: "world-version",
      strategy: "constant",
      position: "before_char_defs",
      insertionOrder: 10,
      enabled: true,
    };
    const sessionEntry: LorebookEntry = {
      ...worldEntry,
      source: "session",
      content: "session-version-with-more-text",
      insertionOrder: 999,
    };

    registry.setLayer("world", [worldEntry]);
    registry.setLayer("session", [sessionEntry]);

    const ctx = createLorebookFromRegistry(registry);
    const result = ctx.applyLorebook({
      messages: [],
      budget: { maxTokens: 10_000, estimator: charEstimator },
    });

    const bucket = result.entriesByPosition.get("before_char_defs") ?? [];
    expect(bucket).toHaveLength(1);
    expect(bucket[0]!.content).toBe("session-version-with-more-text");
    expect(bucket[0]!.source).toBe("session");
  });
});
