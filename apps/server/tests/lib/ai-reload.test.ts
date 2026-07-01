import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiStack, reloadAiStack } from "../../src/ai-setup.js";

const SLOT_ALPHA = `
[covel.alpha]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;

const SLOT_BETA = `
[covel.beta]
provider = "deepseek"
model    = "deepseek-reasoner"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;

const BROKEN = `
[covel.alpha]
provider = "deepseek"
model    =
`;

describe("reloadAiStack", () => {
  let dir: string;
  let tomlPath: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-ai-reload-"));
    tomlPath = path.join(dir, "llm.toml");
    prevEnv = process.env.COVEL_LLM_TOML;
    process.env.COVEL_LLM_TOML = tomlPath;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.COVEL_LLM_TOML;
    else process.env.COVEL_LLM_TOML = prevEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it("picks up added/removed slots in place without replacing the gateway", async () => {
    await writeFile(tomlPath, SLOT_ALPHA);
    const ai = createAiStack();
    expect(Object.keys(ai.slotRegistry.listSlots())).toContain("alpha");

    // Capture object identities — reload must reconfigure in place so every
    // adapter built on the gateway keeps working.
    const gatewayBefore = ai.gateway;
    const presetRegistryBefore = ai.presetRegistry;

    await writeFile(tomlPath, SLOT_BETA);
    const result = reloadAiStack(ai);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.slots).toEqual(["beta"]);

    // New slot resolves, old one is gone.
    expect(ai.slotRegistry.resolveSlot("beta")).toBeTruthy();
    expect(ai.slotRegistry.resolveSlot("alpha")).toBeUndefined();

    // Same gateway + registry objects (reconfigured, not rebuilt).
    expect(ai.gateway).toBe(gatewayBefore);
    expect(ai.presetRegistry).toBe(presetRegistryBefore);
  });

  it("surfaces a parse error and falls back to the built-in default", async () => {
    await writeFile(tomlPath, SLOT_ALPHA);
    const ai = createAiStack();

    await writeFile(tomlPath, BROKEN);
    const result = reloadAiStack(ai);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(ai.lastLoadError).toBe(result.error);

    // Fell back to the built-in default story slot; the broken slot is gone.
    expect(result.slots).toEqual(["story"]);
    expect(ai.slotRegistry.resolveSlot("alpha")).toBeUndefined();
    expect(ai.slotRegistry.resolveSlot("story")).toBeTruthy();
  });

  it("clears lastLoadError once a subsequent reload parses cleanly", async () => {
    await writeFile(tomlPath, BROKEN);
    const ai = createAiStack();
    expect(ai.lastLoadError).toBeTruthy();

    await writeFile(tomlPath, SLOT_ALPHA);
    const result = reloadAiStack(ai);

    expect(result.ok).toBe(true);
    expect(ai.lastLoadError).toBeUndefined();
    expect(ai.slotRegistry.resolveSlot("alpha")).toBeTruthy();
  });
});
