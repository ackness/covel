import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveReasoningEffortProfile,
  setReasoningModelOverrides,
} from "@covel/ai-provider";
import { createAiStack } from "../../src/ai-setup.js";

describe("user reasoning model entries", () => {
  let dir: string;
  const previous = {
    config: process.env.COVEL_USER_CONFIG_DIR,
    toml: process.env.COVEL_LLM_TOML,
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-reasoning-models-"));
    process.env.COVEL_USER_CONFIG_DIR = dir;
    process.env.COVEL_LLM_TOML = path.join(dir, "llm.toml");
  });

  afterEach(async () => {
    for (const [key, value] of [
      ["COVEL_USER_CONFIG_DIR", previous.config],
      ["COVEL_LLM_TOML", previous.toml],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setReasoningModelOverrides(null);
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const levels = () =>
    resolveReasoningEffortProfile("kimi-k3")?.options.map(
      (option) => option.value,
    );

  it("reads reasoning-models.json from the user config directory", async () => {
    await writeFile(
      path.join(dir, "reasoning-models.json"),
      JSON.stringify({
        families: [
          {
            id: "compatible",
            rules: [{ match: "kimi-k3", levels: ["low", "high", "max"] }],
          },
        ],
      }),
    );

    createAiStack();

    expect(levels()).toEqual(["low", "high", "max"]);
  });

  it("reports an invalid file and starts with the bundled data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(
      path.join(dir, "reasoning-models.json"),
      JSON.stringify({
        families: [{ id: "compatible", rules: [{ levels: ["low"] }] }],
      }),
    );

    createAiStack();

    expect(levels()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reasoning-models.json"),
    );
  });
});
