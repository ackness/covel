import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAiStack } from "../../src/ai-setup.js";
import { createRawConfigApiRoutes } from "../../src/routes/raw-config-api.js";

const ALPHA = `
[covel.alpha]
provider = "deepseek"
model    = "deepseek-chat"
baseUrl  = "https://api.deepseek.com"
protocol = "openai-chat-v1"
`;
const BETA = ALPHA.replace("covel.alpha", "covel.beta");
const BROKEN = `
[covel.alpha]
provider = "deepseek"
model    =
`;

describe("raw configuration files", () => {
  let dir: string;
  let tomlPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "covel-raw-config-"));
    tomlPath = path.join(dir, "llm.toml");
    for (const key of ["COVEL_LLM_TOML", "COVEL_DESKTOP_REST", "NODE_ENV"]) {
      saved[key] = process.env[key];
    }
    process.env.COVEL_LLM_TOML = tomlPath;
    delete process.env.COVEL_DESKTOP_REST;
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(initial?: string) {
    if (initial !== undefined) await writeFile(tomlPath, initial);
    const ai = createAiStack();
    const app = createRawConfigApiRoutes({ ai });
    const get = async () =>
      (await (await app.request("/api/config/raw/llm.toml")).json()) as {
        content: string;
        digest: string;
        exists: boolean;
      };
    const put = (content: string, baseDigest: string) =>
      app.request("/api/config/raw/llm.toml", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, baseDigest }),
      });
    return { ai, app, get, put };
  }

  it("lists llm.toml and, outside the desktop shell, no config.toml", async () => {
    const { app } = await setup(ALPHA);
    const body = (await (await app.request("/api/config/raw")).json()) as {
      items: { name: string; path: string; exists: boolean }[];
    };
    expect(body.items).toEqual([
      { name: "llm.toml", path: tomlPath, exists: true, applies: "reload" },
    ]);
    expect((await app.request("/api/config/raw/keys.env")).status).toBe(404);
  });

  it("saves a valid text, keeps the earlier file, and applies it at once", async () => {
    const { ai, get, put } = await setup(ALPHA);
    const loaded = await get();
    expect(loaded.content).toBe(ALPHA);

    const res = await put(BETA, loaded.digest);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      content: BETA,
      backup: `${tomlPath}.bak`,
      reload: { ok: true, slots: ["beta"] },
    });
    expect(await readFile(tomlPath, "utf-8")).toBe(BETA);
    expect(await readFile(`${tomlPath}.bak`, "utf-8")).toBe(ALPHA);
    expect(ai.slotRegistry.resolveSlot("beta")).toBeTruthy();
  });

  it("refuses a text that does not parse and writes nothing", async () => {
    const { get, put } = await setup(ALPHA);
    const res = await put(BROKEN, (await get()).digest);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "config_file_invalid",
    );
    expect(await readFile(tomlPath, "utf-8")).toBe(ALPHA);
    expect(existsSync(`${tomlPath}.bak`)).toBe(false);
  });

  it("refuses to save over a file that changed after it was loaded", async () => {
    const { get, put } = await setup(ALPHA);
    const { digest } = await get();
    await writeFile(tomlPath, BETA);
    const res = await put(ALPHA.replace("alpha", "gamma"), digest);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "config_file_changed",
    );
    expect(await readFile(tomlPath, "utf-8")).toBe(BETA);
  });

  it("offers the starter text for a file that does not exist and creates it on save", async () => {
    const { get, put } = await setup();
    const loaded = await get();
    expect(loaded.exists).toBe(false);
    expect(loaded.content).toContain("[covel.");
    expect((await put(ALPHA, loaded.digest)).status).toBe(200);
    expect(await readFile(tomlPath, "utf-8")).toBe(ALPHA);
  });

  it("is closed in production without the opt-in", async () => {
    const { app } = await setup(ALPHA);
    process.env.NODE_ENV = "production";
    expect((await app.request("/api/config/raw/llm.toml")).status).toBe(403);
  });
});
