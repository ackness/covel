import { describe, it, expect } from "vitest";
import { validateManifest } from "../src/loader/manifest-validator.js";

const MINIMAL_MANIFEST = {
  schemaVersion: "1.0",
  id: "test-plugin",
  displayName: "Test Plugin",
  version: "0.1.0",
  author: "test",
  description: "A test plugin",
  defaultLocale: "zh-CN",
  supportedLocales: ["zh-CN", "en-US"],
};

describe("manifest-validator", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateManifest(MINIMAL_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("test-plugin");
    }
  });

  it("accepts a full manifest with all optional fields", () => {
    const full = {
      ...MINIMAL_MANIFEST,
      loadingOrder: 10,
      requires: ["other-plugin"],
      supersedes: [],
      conflicts: [],
      compatibility: { "@covel/kernel": ">=0.1.0" },
      runtimes: [
        {
          id: "main",
          pluginId: "test-plugin",
          kind: "plugin",
          phase: "post_story",
          trigger: { mode: "always" },
          tools: ["test-tool"],
          hooks: [],
          budget: { maxSteps: 5, timeoutMs: 30000 },
        },
      ],
      tools: [
        { id: "test-tool", kind: "query" },
      ],
      hooks: [
        {
          id: "test-hook",
          event: "TurnStart",
          handlerKind: "command",
        },
      ],
      permissions: ["read:world"],
      providers: [
        { id: "llm", kind: "llm" },
      ],
      runtimeSettings: [
        {
          key: "difficulty",
          type: "enum",
          label: { "zh-CN": "难度", "en-US": "Difficulty" },
          options: [
            { label: "Easy", value: "easy" },
            { label: "Hard", value: "hard" },
          ],
        },
      ],
    };
    const result = validateManifest(full);
    expect(result.ok).toBe(true);
  });

  it("rejects a manifest missing required fields", () => {
    const result = validateManifest({ schemaVersion: "1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects invalid runtime kind", () => {
    const manifest = {
      ...MINIMAL_MANIFEST,
      runtimes: [
        {
          id: "x",
          pluginId: "test-plugin",
          kind: "invalid-kind",
          phase: "story",
          trigger: { mode: "always" },
          tools: [],
          hooks: [],
        },
      ],
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it("rejects invalid hook event", () => {
    const manifest = {
      ...MINIMAL_MANIFEST,
      hooks: [
        { id: "h", event: "InvalidEvent", handlerKind: "command" },
      ],
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it("accepts i18n displayName as object", () => {
    const manifest = {
      ...MINIMAL_MANIFEST,
      displayName: { "zh-CN": "测试插件", "en-US": "Test Plugin" },
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
  });
});
