// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import type { DataStore, WorldRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

/**
 * A model that translates: it answers each text it is given with the same
 * text in brackets, and gives no terms when it is asked for a glossary.
 */
class BracketTranslator implements LLMAdapter {
  calls = 0;
  async generate(request: {
    messages: readonly { content: unknown }[];
  }): Promise<LLMResponse> {
    this.calls += 1;
    const prompt = String(request.messages[0]!.content);
    const reply: Record<string, string> = {};
    // The texts are a JSON object at the end of the prompt: id to text, or
    // id to `{ text, note }`.
    const start = prompt.indexOf("Texts:\n");
    if (start >= 0) {
      const texts = JSON.parse(
        prompt.slice(start + "Texts:\n".length),
      ) as Record<string, string | { text: string }>;
      for (const [id, value] of Object.entries(texts))
        reply[id] = `【${typeof value === "string" ? value : value.text}】`;
    }
    return {
      content: JSON.stringify(reply),
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function readSse(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("POST /api/worlds/:id/translate", () => {
  let home: string;
  let userWorlds: string;
  let bundledWorlds: string;
  let store: DataStore;
  let llm: BracketTranslator;
  let app: Hono;
  let window = 0;

  const writeWorld = async (root: string, id: string) => {
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "world.yaml"),
      `schemaVersion: "1.0"\nid: ${id}\nname: Ash Harbor\nsummary: A port that burns every winter.\ndefaultLocale: en-US\n`,
    );
    await writeFile(
      path.join(dir, "WORLD.md"),
      "# Ash Harbor\n\nThe harbor burns every winter and is rebuilt every spring.\n",
    );
    const record = (await loadSingleWorld(dir, { source: "file" }))!;
    await store.createWorld(record);
    return dir;
  };
  const translate = (id: string, body: object) =>
    app.request(`/api/worlds/${id}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    // Each case gets its own rate-limit window.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + ++window * 60_001);
    home = await mkdtemp(path.join(tmpdir(), "covel-translate-"));
    userWorlds = path.join(home, "user-worlds");
    bundledWorlds = path.join(home, "bundled-worlds");
    vi.stubEnv("COVEL_USER_WORLDS_DIR", userWorlds);
    store = createMemoryStore();
    llm = new BracketTranslator();
    const sessionLock = createInProcessSessionLock();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as never);
      c.set("llmAdapter" as never, llm as never);
      c.set("sessionLock" as never, sessionLock as never);
      c.set("worldsDirs" as never, [bundledWorlds, userWorlds] as never);
      await next();
    });
    app.route("/api/worlds", worldRoutes);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("writes the edition beside the world's files and declares it", async () => {
    const dir = await writeWorld(userWorlds, "ash-harbor");

    const events = await readSse(
      await translate("ash-harbor", { locale: "ja_jp" }),
    );

    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const done = events.find((event) => event.type === "done") as {
      world: WorldRecord;
      total: number;
      translated: number;
      failed: number;
    };
    expect(done).toMatchObject({ total: 3, translated: 3, failed: 0 });
    expect(events.some((event) => event.type === "progress")).toBe(true);
    // Only translated text is in the locale files; the structure is not copied.
    expect(await readFile(path.join(dir, "world.ja-JP.yaml"), "utf8")).toBe(
      "name: 【Ash Harbor】\nsummary: 【A port that burns every winter.】\n",
    );
    expect(await readFile(path.join(dir, "WORLD.ja-JP.md"), "utf8")).toContain(
      "【# Ash Harbor",
    );
    // A session may now use the edition.
    expect(await readFile(path.join(dir, "world.yaml"), "utf8")).toContain(
      "supportedLocales:\n  - en-US\n  - ja-JP\n",
    );
    expect(done.world.metadata?.supportedLocales).toEqual(["en-US", "ja-JP"]);
    expect(
      (await store.getWorld("ash-harbor"))?.metadata?.supportedLocales,
    ).toEqual(["en-US", "ja-JP"]);

    // Nothing is left to translate, and no model call is made to find out.
    const calls = llm.calls;
    const again = await translate("ash-harbor", { locale: "ja-JP" });
    expect(again.status).toBe(409);
    await expect(again.json()).resolves.toMatchObject({
      code: "world_already_translated",
    });
    expect(llm.calls).toBe(calls);
  });

  it("does not write into a world outside the user's world directory", async () => {
    const dir = await writeWorld(bundledWorlds, "shipped-world");
    const response = await translate("shipped-world", { locale: "ja-JP" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "world_not_translatable",
    });
    expect(llm.calls).toBe(0);
    await expect(
      readFile(path.join(dir, "world.ja-JP.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("asks for a language and a world it knows", async () => {
    await writeWorld(userWorlds, "ash-harbor");
    expect((await translate("ash-harbor", {})).status).toBe(400);
    expect((await translate("ash-harbor", { locale: "notes" })).status).toBe(
      400,
    );
    expect((await translate("missing", { locale: "ja-JP" })).status).toBe(404);
  });
});
