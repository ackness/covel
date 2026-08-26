import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDbRoutes } from "../../src/routes/model-db.js";
import type { AiStack } from "../../src/ai-setup.js";

describe("model database refresh", () => {
  const previousUserConfigDir = process.env.COVEL_USER_CONFIG_DIR;
  let tmpDir: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousUserConfigDir === undefined) {
      delete process.env.COVEL_USER_CONFIG_DIR;
    } else {
      process.env.COVEL_USER_CONFIG_DIR = previousUserConfigDir;
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("bootstraps an absent bundled database and persists the refresh", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-model-db-"));
    process.env.COVEL_USER_CONFIG_DIR = tmpDir;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            "openai/test-model": {
              mode: "chat",
              litellm_provider: "openai",
              max_input_tokens: 128000,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const ai = { modelDb: null } as AiStack;
    const app = createModelDbRoutes(ai);

    const response = await app.request("/api/model-db/refresh", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      count: 1,
      persisted: true,
    });
    expect(ai.modelDb?.lookup("openai/test-model")?.contextWindow).toBe(128000);
    expect(fs.existsSync(path.join(tmpDir, "model-db.json"))).toBe(true);
  });
});
