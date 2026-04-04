import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateManifest } from "@covel/plugin-runtime";
import {
  unlockEntry,
  updateEntry,
  getEntriesByCategory,
  findEntryByTitle,
  getCodexSummary,
  EMPTY_STATE,
} from "../server/codex-logic.js";
import {
  unlockCodexEntryTool,
  updateCodexEntryTool,
} from "../server/tools.js";
import { codexContextProvider } from "../server/context-provider.js";
import type { ToolExecutionContext } from "@covel/shared";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Helpers ──────────────────────────────────────────────────

let idCounter = 0;
function deterministicId(): string {
  idCounter += 1;
  return `test-id-${idCounter}`;
}

function resetIds(): void {
  idCounter = 0;
}

function makeToolCtx(
  input: unknown,
  locale = "en-US",
  state?: Record<string, unknown>,
): ToolExecutionContext {
  return {
    input,
    runtimeId: "codex-tracker",
    pluginId: "core-codex",
    locale,
    state,
  };
}

// ── codex-logic unit tests ──────────────────────────────────

describe("codex-logic", () => {
  describe("unlockEntry", () => {
    it("creates a new entry with provided fields", () => {
      resetIds();
      const { state, entry } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Fire Dragon",
          content: "A fearsome dragon that breathes fire.",
          tags: ["dragon", "fire", "boss"],
          imageHint: "a large red dragon breathing fire",
        },
        deterministicId,
      );

      expect(entry.entryId).toBe("test-id-1");
      expect(entry.category).toBe("monster");
      expect(entry.title).toBe("Fire Dragon");
      expect(entry.content).toBe("A fearsome dragon that breathes fire.");
      expect(entry.tags).toEqual(["dragon", "fire", "boss"]);
      expect(entry.imageHint).toBe("a large red dragon breathing fire");
      expect(entry.discoveredAt).toBeDefined();
      expect(entry.updatedAt).toBeUndefined();

      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]).toEqual(entry);
    });

    it("appends entry without mutating original state", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "item",
          title: "Healing Potion",
          content: "Restores health.",
          tags: ["potion", "healing"],
        },
        deterministicId,
      );

      const { state: s2 } = unlockEntry(
        s1,
        {
          category: "location",
          title: "Dark Forest",
          content: "A mysterious forest.",
          tags: ["forest"],
        },
        deterministicId,
      );

      expect(EMPTY_STATE.entries).toHaveLength(0);
      expect(s1.entries).toHaveLength(1);
      expect(s2.entries).toHaveLength(2);
    });

    it("creates entry without optional imageHint", () => {
      resetIds();
      const { entry } = unlockEntry(
        EMPTY_STATE,
        {
          category: "lore",
          title: "Ancient Prophecy",
          content: "A prophecy foretelling doom.",
          tags: ["prophecy"],
        },
        deterministicId,
      );

      expect(entry.imageHint).toBeUndefined();
    });

    it("creates entry with empty tags", () => {
      resetIds();
      const { entry } = unlockEntry(
        EMPTY_STATE,
        {
          category: "character",
          title: "Mysterious Stranger",
          content: "A hooded figure.",
          tags: [],
        },
        deterministicId,
      );

      expect(entry.tags).toEqual([]);
    });
  });

  describe("updateEntry", () => {
    it("updates content and tags of an existing entry", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Goblin",
          content: "A small green creature.",
          tags: ["goblin"],
        },
        deterministicId,
      );

      const s2 = updateEntry(s1, "test-id-1", {
        content: "A small green creature, known for its cunning.",
        tags: ["goblin", "cunning"],
      });

      const updated = s2.entries.find((e) => e.entryId === "test-id-1");
      expect(updated?.content).toBe(
        "A small green creature, known for its cunning.",
      );
      expect(updated?.tags).toEqual(["goblin", "cunning"]);
      expect(updated?.updatedAt).toBeDefined();
    });

    it("updates only imageHint without changing other fields", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "item",
          title: "Magic Sword",
          content: "A glowing blade.",
          tags: ["sword", "magic"],
        },
        deterministicId,
      );

      const s2 = updateEntry(s1, "test-id-1", {
        imageHint: "a glowing blue sword with runes",
      });

      const updated = s2.entries.find((e) => e.entryId === "test-id-1");
      expect(updated?.content).toBe("A glowing blade.");
      expect(updated?.tags).toEqual(["sword", "magic"]);
      expect(updated?.imageHint).toBe("a glowing blue sword with runes");
    });

    it("throws for nonexistent entry", () => {
      expect(() =>
        updateEntry(EMPTY_STATE, "nope", { content: "new" }),
      ).toThrow("Codex entry not found: nope");
    });

    it("does not mutate the original state", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Slime",
          content: "A wobbly blob.",
          tags: ["slime"],
        },
        deterministicId,
      );

      const s2 = updateEntry(s1, "test-id-1", { content: "An evolved slime." });

      expect(s1.entries[0].content).toBe("A wobbly blob.");
      expect(s2.entries[0].content).toBe("An evolved slime.");
    });
  });

  describe("getEntriesByCategory", () => {
    it("returns entries filtered by category", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Goblin",
          content: "Green creature.",
          tags: [],
        },
        deterministicId,
      );
      const { state: s2 } = unlockEntry(
        s1,
        {
          category: "item",
          title: "Potion",
          content: "Heals HP.",
          tags: [],
        },
        deterministicId,
      );
      const { state: s3 } = unlockEntry(
        s2,
        {
          category: "monster",
          title: "Dragon",
          content: "Big lizard.",
          tags: [],
        },
        deterministicId,
      );

      const monsters = getEntriesByCategory(s3, "monster");
      expect(monsters).toHaveLength(2);
      expect(monsters[0].title).toBe("Goblin");
      expect(monsters[1].title).toBe("Dragon");
    });

    it("returns empty array when no entries match", () => {
      expect(getEntriesByCategory(EMPTY_STATE, "lore")).toHaveLength(0);
    });
  });

  describe("findEntryByTitle", () => {
    it("finds entry by exact title (case-insensitive)", () => {
      resetIds();
      const { state } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Fire Dragon",
          content: "Burns things.",
          tags: [],
        },
        deterministicId,
      );

      const found = findEntryByTitle(state, "fire dragon");
      expect(found?.title).toBe("Fire Dragon");
    });

    it("finds entry by partial title match", () => {
      resetIds();
      const { state } = unlockEntry(
        EMPTY_STATE,
        {
          category: "location",
          title: "Enchanted Dark Forest",
          content: "Spooky trees.",
          tags: [],
        },
        deterministicId,
      );

      const found = findEntryByTitle(state, "dark forest");
      expect(found?.title).toBe("Enchanted Dark Forest");
    });

    it("returns undefined when no entry matches", () => {
      expect(findEntryByTitle(EMPTY_STATE, "nothing")).toBeUndefined();
    });
  });

  describe("getCodexSummary", () => {
    it("returns no-entries message for empty state (en)", () => {
      expect(getCodexSummary(EMPTY_STATE, "en-US")).toBe(
        "No codex entries discovered yet.",
      );
    });

    it("returns no-entries message for empty state (zh)", () => {
      expect(getCodexSummary(EMPTY_STATE, "zh-CN")).toBe(
        "尚未发现任何图鉴条目。",
      );
    });

    it("groups entries by category", () => {
      resetIds();
      const { state: s1 } = unlockEntry(
        EMPTY_STATE,
        {
          category: "monster",
          title: "Goblin",
          content: "Green creature.",
          tags: ["goblin"],
        },
        deterministicId,
      );
      const { state: s2 } = unlockEntry(
        s1,
        {
          category: "item",
          title: "Potion",
          content: "Heals HP.",
          tags: ["potion"],
        },
        deterministicId,
      );
      const { state: s3 } = unlockEntry(
        s2,
        {
          category: "monster",
          title: "Dragon",
          content: "Big lizard.",
          tags: ["dragon"],
        },
        deterministicId,
      );

      const summary = getCodexSummary(s3, "en-US");
      expect(summary).toContain("## Monster");
      expect(summary).toContain("Goblin");
      expect(summary).toContain("Dragon");
      expect(summary).toContain("## Item");
      expect(summary).toContain("Potion");
    });

    it("uses Chinese category headers for zh locale", () => {
      resetIds();
      const { state } = unlockEntry(
        EMPTY_STATE,
        {
          category: "location",
          title: "Dark Forest",
          content: "Spooky.",
          tags: [],
        },
        deterministicId,
      );

      const summary = getCodexSummary(state, "zh-CN");
      expect(summary).toContain("## 地点");
      expect(summary).toContain("Dark Forest");
    });
  });
});

// ── Tool wrapper tests ──────────────────────────────────────

describe("tools", () => {
  describe("unlockCodexEntryTool", () => {
    it("returns proposals with state.patch, record.upsert, event.emit, ui.render", async () => {
      const result = await unlockCodexEntryTool(
        makeToolCtx({
          category: "monster",
          title: "Fire Dragon",
          content: "A fearsome dragon.",
          tags: ["dragon", "fire"],
        }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("entryId");
      expect(output).toHaveProperty("message");
      expect(result.proposals).toHaveLength(4);

      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
      expect(kinds).toContain("event.emit");
      expect(kinds).toContain("ui.render");

      const eventProposal = result.proposals!.find(
        (p) => p.kind === "event.emit",
      );
      expect((eventProposal?.payload as Record<string, unknown>).type).toBe(
        "codex_unlocked",
      );
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const result = await unlockCodexEntryTool(
        makeToolCtx(
          {
            category: "item",
            title: "治愈药水",
            content: "恢复生命值的药水",
            tags: ["药水"],
          },
          "zh-CN",
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已解锁");
      expect(msg).toContain("治愈药水");
    });

    it("includes record.upsert with entry data", async () => {
      const result = await unlockCodexEntryTool(
        makeToolCtx({
          category: "lore",
          title: "Ancient Legend",
          content: "A tale of old times.",
          tags: ["legend", "ancient"],
          imageHint: "ancient scroll with glowing runes",
        }),
      );

      const record = result.proposals!.find((p) => p.kind === "record.upsert");
      const payload = record?.payload as Record<string, unknown>;
      expect(payload.recordType).toBe("codex");

      const value = payload.value as Record<string, unknown>;
      expect(value.title).toBe("Ancient Legend");
      expect(value.category).toBe("lore");
    });

    it("includes ui.render with codex_entry block", async () => {
      const result = await unlockCodexEntryTool(
        makeToolCtx({
          category: "character",
          title: "Dark Knight",
          content: "A mysterious armored figure.",
          tags: ["knight"],
        }),
      );

      const uiBlock = result.proposals!.find((p) => p.kind === "ui.render");
      const payload = uiBlock?.payload as Record<string, unknown>;
      expect(payload.blockType).toBe("codex_entry");

      const data = payload.data as Record<string, unknown>;
      expect(data.action).toBe("unlock");
      expect(data.title).toBe("Dark Knight");
    });

    it("returns error for invalid input", async () => {
      const result = await unlockCodexEntryTool(
        makeToolCtx({ category: "invalid_category" }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
      expect(result.proposals).toBeUndefined();
    });
  });

  describe("updateCodexEntryTool", () => {
    it("returns state.patch, record.upsert, ui.render proposals", async () => {
      // First unlock an entry
      const unlockResult = await unlockCodexEntryTool(
        makeToolCtx({
          category: "monster",
          title: "Goblin",
          content: "Small green creature.",
          tags: ["goblin"],
        }),
      );

      const entryId = (unlockResult.output as Record<string, unknown>)
        .entryId as string;
      const patchPayload = unlockResult.proposals!.find(
        (p) => p.kind === "state.patch",
      )?.payload as Record<string, unknown>;
      const statePatch = patchPayload.patch as Record<string, unknown>;

      // Now update using the state from the unlock
      const result = await updateCodexEntryTool(
        makeToolCtx(
          {
            entryId,
            content: "Small green creature, very cunning.",
            tags: ["goblin", "cunning"],
          },
          "en-US",
          { "core-codex": statePatch },
        ),
      );

      expect(result.proposals).toHaveLength(3);
      const kinds = result.proposals!.map((p) => p.kind);
      expect(kinds).toContain("state.patch");
      expect(kinds).toContain("record.upsert");
      expect(kinds).toContain("ui.render");

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain(entryId);
    });

    it("returns zh-CN message for Chinese locale", async () => {
      const unlockResult = await unlockCodexEntryTool(
        makeToolCtx({
          category: "monster",
          title: "哥布林",
          content: "绿色小生物。",
          tags: ["哥布林"],
        }),
      );

      const entryId = (unlockResult.output as Record<string, unknown>)
        .entryId as string;
      const patchPayload = unlockResult.proposals!.find(
        (p) => p.kind === "state.patch",
      )?.payload as Record<string, unknown>;
      const statePatch = patchPayload.patch as Record<string, unknown>;

      const result = await updateCodexEntryTool(
        makeToolCtx(
          {
            entryId,
            content: "绿色小生物，非常狡猾。",
          },
          "zh-CN",
          { "core-codex": statePatch },
        ),
      );

      const msg = (result.output as Record<string, unknown>).message as string;
      expect(msg).toContain("已更新");
    });

    it("returns error for nonexistent entry", async () => {
      const result = await updateCodexEntryTool(
        makeToolCtx({
          entryId: "nonexistent",
          content: "updated content",
        }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });

    it("returns error for invalid input", async () => {
      const result = await updateCodexEntryTool(
        makeToolCtx({ noEntryId: true }),
      );

      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("error");
    });
  });
});

// ── Context provider tests ──────────────────────────────────

describe("codexContextProvider", () => {
  it("returns empty message for no entries", async () => {
    const result = (await codexContextProvider({
      pluginId: "core-codex",
      runtimeId: "codex-tracker",
      locale: "en-US",
      state: {},
    })) as Record<string, unknown>;

    expect(result.content).toBe("No codex entries discovered yet.");
  });

  it("returns codex summary for discovered entries", async () => {
    resetIds();
    const { state } = unlockEntry(
      EMPTY_STATE,
      {
        category: "monster",
        title: "Fire Dragon",
        content: "Burns things.",
        tags: ["dragon"],
      },
      deterministicId,
    );

    const result = (await codexContextProvider({
      pluginId: "core-codex",
      runtimeId: "codex-tracker",
      locale: "en-US",
      state: { "core-codex": state },
    })) as Record<string, unknown>;

    expect((result.content as string)).toContain("Fire Dragon");
    expect(result.priority).toBe(60);
  });

  it("returns zh-CN content for Chinese locale", async () => {
    const result = (await codexContextProvider({
      pluginId: "core-codex",
      runtimeId: "codex-tracker",
      locale: "zh-CN",
      state: {},
    })) as Record<string, unknown>;

    expect(result.title).toBe("已发现的图鉴条目");
    expect(result.content).toBe("尚未发现任何图鉴条目。");
  });
});
