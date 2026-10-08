// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import type { DataStore, WorldRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  SessionLockTimeoutError,
  createInProcessSessionLock,
} from "../../src/lib/session-lock.js";
import { makeErrorHandler } from "../../src/api-error.js";
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

class DelayedTranslator extends BracketTranslator {
  private start!: () => void;
  private resume!: () => void;
  readonly started = new Promise<void>((resolve) => (this.start = resolve));
  private readonly gate = new Promise<void>(
    (resolve) => (this.resume = resolve),
  );

  release() {
    this.resume();
  }

  override async generate(request: {
    messages: readonly { content: unknown }[];
  }): Promise<LLMResponse> {
    this.start();
    await this.gate;
    return super.generate(request);
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

  const writeWorld = async (root: string, id: string, save = true) => {
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
    if (save) await store.createWorld(record);
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
    app.onError(makeErrorHandler("[translate test]", false));
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

  it.each(["store", "model"])(
    "redacts %s failures on the already-open SSE stream",
    async (seam) => {
      vi.stubEnv("NODE_ENV", "production");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await writeWorld(userWorlds, "failure-world");
      const marker = "INTERNAL_TRANSLATION_DIAGNOSTIC";
      if (seam === "store")
        vi.spyOn(store, "upsertWorld").mockRejectedValueOnce(new Error(marker));
      else
        vi.spyOn(llm, "generate").mockImplementation(async (request) => {
          // Glossary succeeds; provider failures reach the stream catch.
          if (String(request.messages[0]!.content).includes("Texts:\n"))
            throw new Error(marker);
          return {
            content: "{}",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        });
      const response = await translate("failure-world", { locale: "ja-JP" });
      expect(response.status).toBe(200);
      const events = await readSse(response);
      expect(events.filter((e) => e.type === "error")).toEqual([
        { type: "error", message: "Internal server error" },
      ]);
      expect(events.some((e) => e.type === "done")).toBe(false);
      expect(JSON.stringify(events)).not.toContain(marker);
      expect(log.mock.calls.flat().join(" ")).toContain(marker);
    },
  );

  it("says why every text was refused, also in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await writeWorld(userWorlds, "refused-translation");
    // Every translation adds a placeholder its source text does not have.
    vi.spyOn(llm, "generate").mockImplementation(async (request) => {
      const content = String(request.messages[0]!.content);
      const start = content.indexOf("Texts:\n");
      const texts =
        start < 0 ? {} : JSON.parse(content.slice(start + "Texts:\n".length));
      return {
        content: JSON.stringify(
          Object.fromEntries(Object.keys(texts).map((id) => [id, "{extra}"])),
        ),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    const events = await readSse(
      await translate("refused-translation", { locale: "ja-JP" }),
    );
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.message)).toMatch(/^placeholders changed: /);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it.each(["production", "development"])(
    "keeps the known no-translation message in %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      await writeWorld(userWorlds, "empty-translation");
      vi.spyOn(llm, "generate").mockResolvedValue({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      const events = await readSse(
        await translate("empty-translation", { locale: "ja-JP" }),
      );
      expect(events.filter((event) => event.type === "error")).toEqual([
        { type: "error", message: "no translation" },
      ]);
    },
  );

  it.each(["production", "development"])(
    "uses the safe lock-busy message after opening SSE in %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await writeWorld(userWorlds, "busy-translation");
      vi.spyOn(store, "upsertWorld").mockRejectedValueOnce(
        new SessionLockTimeoutError("INTERNAL_TRANSLATION_LOCK"),
      );
      const response = await translate("busy-translation", { locale: "ja-JP" });
      expect(response.status).toBe(200);
      const events = await readSse(response);
      expect(events.filter((event) => event.type === "error")).toEqual([
        { type: "error", message: "Session is busy, please retry" },
      ]);
      expect(log.mock.calls.flat().join(" ")).toContain(
        "INTERNAL_TRANSLATION_LOCK",
      );
    },
  );

  it("retains development diagnostics on SSE without adding response fields", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeWorld(userWorlds, "dev-translation");
    vi.spyOn(store, "upsertWorld").mockRejectedValueOnce(
      new Error("SYNTHETIC_DEV_DIAGNOSTIC"),
    );
    const events = await readSse(
      await translate("dev-translation", { locale: "ja-JP" }),
    );
    expect(events.filter((event) => event.type === "error")).toEqual([
      { type: "error", message: "SYNTHETIC_DEV_DIAGNOSTIC" },
    ]);
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

  it("adds translated lore without reverting an edited default edition", async () => {
    await writeWorld(userWorlds, "edited-world");
    const current = (await store.getWorld("edited-world"))!;
    await store.upsertWorld({
      ...current,
      lore: "Player-edited lore",
      metadata: {
        ...current.metadata,
        packageManaged: true,
        packageModified: true,
      },
    });
    const events = await readSse(
      await translate("edited-world", { locale: "ja-JP" }),
    );
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const saved = await store.getWorld("edited-world");
    expect(saved?.lore).toBe("Player-edited lore");
    expect(saved?.metadata?.localizedText).toMatchObject({
      lore: { "ja-JP": expect.stringContaining("【#") },
    });
  });

  it.each([
    { label: "new creation time", reuseCreatedAt: false, movePackage: false },
    { label: "reused creation time", reuseCreatedAt: true, movePackage: false },
    {
      label: "different package path",
      reuseCreatedAt: true,
      movePackage: true,
    },
  ])(
    "does not publish into a recreated package with $label",
    async ({ reuseCreatedAt, movePackage }) => {
      const dir = await writeWorld(userWorlds, "replaced-world");
      const original = (await store.getWorld("replaced-world"))!;
      await store.upsertWorld({
        ...original,
        metadata: { ...original.metadata, source: "generated-file" },
      });
      const delayed = new DelayedTranslator();
      llm = delayed;
      const pending = readSse(
        await translate("replaced-world", { locale: "ja-JP" }),
      );
      await delayed.started;
      try {
        const deleted = await app.request("/api/worlds/replaced-world", {
          method: "DELETE",
        });
        expect(deleted.status).toBe(200);
        await expect(
          readFile(path.join(dir, "world.yaml"), "utf8"),
        ).rejects.toThrow();
        await writeWorld(userWorlds, "replaced-world", false);
        const recreated = await app.request("/api/worlds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "replaced-world",
            name: "New world",
            lore: "New lore",
            createdAt: reuseCreatedAt
              ? original.createdAt
              : "2099-01-01T00:00:00.000Z",
          }),
        });
        expect(recreated.status).toBe(201);
        const replacementDir = movePackage
          ? path.join(userWorlds, "new-package")
          : dir;
        if (movePackage) await rename(dir, replacementDir);
        await writeFile(
          path.join(replacementDir, "world.ja-JP.yaml"),
          "name: New edition\n",
        );
        await writeFile(
          path.join(replacementDir, "WORLD.ja-JP.md"),
          "New translated lore\n",
        );
        const before = await store.getWorld("replaced-world");
        delayed.release();
        const events = await pending;
        expect(events.some((event) => event.type === "done")).toBe(false);
        expect(events.some((event) => event.type === "error")).toBe(true);
        expect(await store.getWorld("replaced-world")).toEqual(before);
        expect(
          await readFile(path.join(replacementDir, "world.ja-JP.yaml"), "utf8"),
        ).toBe("name: New edition\n");
        expect(
          await readFile(path.join(replacementDir, "WORLD.ja-JP.md"), "utf8"),
        ).toBe("New translated lore\n");
        expect(
          await readFile(path.join(replacementDir, "world.yaml"), "utf8"),
        ).not.toContain("supportedLocales");
      } finally {
        delayed.release();
        await pending;
      }
    },
  );

  it("does not recreate language files after deletion finishes", async () => {
    const dir = await writeWorld(userWorlds, "deleted-world");
    const original = (await store.getWorld("deleted-world"))!;
    await store.upsertWorld({
      ...original,
      metadata: { ...original.metadata, source: "generated-file" },
    });
    const delayed = new DelayedTranslator();
    llm = delayed;
    const pending = readSse(
      await translate("deleted-world", { locale: "ja-JP" }),
    );
    await delayed.started;
    try {
      expect(
        (await app.request("/api/worlds/deleted-world", { method: "DELETE" }))
          .status,
      ).toBe(200);
      delayed.release();
      const events = await pending;
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(await store.getWorld("deleted-world")).toBeNull();
      await expect(
        readFile(path.join(dir, "world.ja-JP.yaml"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(dir, "WORLD.ja-JP.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      delayed.release();
      await pending;
    }
  });

  it("does not publish while the deletion lifecycle is still draining", async () => {
    const dir = await writeWorld(userWorlds, "draining-world");
    const original = (await store.getWorld("draining-world"))!;
    await store.upsertWorld({
      ...original,
      metadata: { ...original.metadata, source: "generated-file" },
    });
    const delayed = new DelayedTranslator();
    llm = delayed;
    const pending = readSse(
      await translate("draining-world", { locale: "ja-JP" }),
    );
    await delayed.started;
    let startDeletion!: () => void;
    let finishDrain!: () => void;
    const deletionStarted = new Promise<void>(
      (resolve) => (startDeletion = resolve),
    );
    const drain = new Promise<void>((resolve) => (finishDrain = resolve));
    vi.spyOn(store, "listSessions").mockImplementationOnce(async () => {
      startDeletion();
      await drain;
      return [];
    });
    const deletion = app.request("/api/worlds/draining-world", {
      method: "DELETE",
    });
    await deletionStarted;
    try {
      delayed.release();
      const events = await pending;
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "done")).toBe(false);
      await expect(
        readFile(path.join(dir, "world.ja-JP.yaml"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(dir, "WORLD.ja-JP.md"), "utf8"),
      ).rejects.toThrow();
      expect(
        await readFile(path.join(dir, "world.yaml"), "utf8"),
      ).not.toContain("supportedLocales");
    } finally {
      delayed.release();
      finishDrain();
      expect((await deletion).status).toBe(200);
      await pending;
    }
  });

  it("keeps editor changes committed while the model is translating", async () => {
    await writeWorld(userWorlds, "concurrent-edit");
    const original = (await store.getWorld("concurrent-edit"))!;
    await store.upsertWorld({
      ...original,
      metadata: { ...original.metadata, packageManaged: true },
    });
    const delayed = new DelayedTranslator();
    llm = delayed;
    const pending = readSse(
      await translate("concurrent-edit", { locale: "ja-JP" }),
    );
    await delayed.started;
    try {
      const patched = await app.request("/api/worlds/concurrent-edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Edited name",
          description: "Edited description",
          lore: "Edited lore",
          tags: ["edited"],
        }),
      });
      expect(patched.status).toBe(200);
      delayed.release();
      const events = await pending;
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(await store.getWorld("concurrent-edit")).toMatchObject({
        name: "Edited name",
        description: "Edited description",
        lore: "Edited lore",
        tags: ["edited"],
        createdAt: original.createdAt,
        metadata: {
          packageModified: true,
          supportedLocales: ["en-US", "ja-JP"],
          localizedText: { lore: { "ja-JP": expect.stringContaining("【#") } },
        },
      });
    } finally {
      delayed.release();
      await pending;
    }
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
