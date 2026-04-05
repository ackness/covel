/**
 * PgStore tests — runs the unified DataStore contract + PG-specific edge cases.
 *
 * Requires: DATABASE_URL=postgresql://covel:covel_dev@localhost:5432/covel
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgStore } from "../src/postgres/pg-store.js";
import { runDataStoreContractTests } from "./store-contract.js";
import type { CharacterRecord, WorldRecord, SessionRecord, MessageRecord } from "../src/types.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://covel:covel_dev@localhost:5432/covel";

// ── Unified Contract Tests ──────────────────────────────────────────────────

let sharedStore: PgStore;

beforeAll(async () => {
  sharedStore = new PgStore({ databaseUrl: DATABASE_URL });
  await sharedStore.initialize();
});

afterAll(async () => {
  await sharedStore.clear();
  await sharedStore.close();
});

runDataStoreContractTests("PgStore", async () => ({
  store: sharedStore,
  cleanup: async () => {
    await sharedStore.clear();
  },
}));

// ── PG-Specific Edge Cases ──────────────────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

describe("PgStore — Edge Cases", () => {
  beforeEach(async () => {
    await sharedStore.clear();
  });

  it("should handle optional fields being undefined", async () => {
    const world: WorldRecord = {
      id: uid("world"), name: "W", description: "d", createdAt: new Date().toISOString(),
    };
    await sharedStore.upsertWorld(world);

    const fetched = await sharedStore.getWorld(world.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.lore).toBeUndefined();
    expect(fetched!.tags).toBeUndefined();
  });

  it("should handle JSONB with complex nested objects", async () => {
    const char: CharacterRecord = {
      id: uid("char"), worldId: "w1", name: "Hero", type: "player",
      version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      fields: {
        stats: { str: 10, dex: 15, int: 12 },
        inventory: [{ name: "Sword", damage: 5 }, { name: "Shield", armor: 3 }],
        nested: { deep: { value: true } },
      },
    };
    await sharedStore.upsertCharacter(char);

    const chars = await sharedStore.listCharacters();
    expect(chars[0].fields).toEqual(char.fields);
  });

  it("should handle concurrent writes", async () => {
    const worlds = Array.from({ length: 20 }, (_, i) => ({
      id: `concurrent_${i}`, name: `World ${i}`, description: "d",
      createdAt: new Date().toISOString(),
    } as WorldRecord));
    await Promise.all(worlds.map((w) => sharedStore.upsertWorld(w)));

    const all = await sharedStore.listWorlds();
    expect(all).toHaveLength(20);
  });

  it("should fallback invalid character type to 'npc'", async () => {
    const char: CharacterRecord = {
      id: uid("char"), worldId: "w1", name: "Hero", type: "player",
      version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await sharedStore.upsertCharacter(char);
    // Corrupt the type directly in DB
    const pgClient = (sharedStore as any).sql;
    await pgClient`UPDATE characters SET type = 'invalid_type' WHERE id = ${char.id}`;
    const chars = await sharedStore.listCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0].type).toBe("npc");
  });
});
