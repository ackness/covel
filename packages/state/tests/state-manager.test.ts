import { describe, it, expect, beforeEach } from "vitest";
import { createStateManager } from "../src/state-manager.js";
import type {
  StateManager,
  StateChangeMetadata,
} from "../src/state-manager.js";
import type { StateTableSchema } from "@covel/shared";
import { createMemoryStore } from "@covel/store";

const meta = (
  turnId: string,
  changedBy = "plugin/runtime",
): StateChangeMetadata => ({
  changedBy,
  turnId,
  reason: "test",
});

const hpSchema: StateTableSchema = {
  name: "stats",
  fields: [
    { name: "hp", type: "integer", default: 100 },
    { name: "mp", type: "integer", default: 50 },
    { name: "name", type: "string" },
  ],
};

describe("StateManager", () => {
  let sm: StateManager;
  const sid = "session-1";

  beforeEach(() => {
    sm = createStateManager(createMemoryStore());
  });

  describe("createTable + getTableSchemas", () => {
    it("should create a table and retrieve its schema", async () => {
      await sm.createTable(sid, hpSchema);
      const schemas = await sm.getTableSchemas(sid);
      expect(schemas).toHaveLength(1);
      expect(schemas[0]).toEqual(hpSchema);
    });
  });

  describe("dropTable", () => {
    it("should remove the table from schemas", async () => {
      await sm.createTable(sid, hpSchema);
      await sm.dropTable(sid, "stats");
      const schemas = await sm.getTableSchemas(sid);
      expect(schemas).toHaveLength(0);
    });
  });

  describe("setValue + getValue", () => {
    it("should set a field and get returns the value", async () => {
      await sm.createTable(sid, hpSchema);
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-1"));
      expect(await sm.getValue(sid, "stats", "hp")).toBe(80);
    });
  });

  describe("getTableSnapshot", () => {
    it("should return all current values for a table", async () => {
      await sm.createTable(sid, hpSchema);
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-1"));
      await sm.setValue(sid, "stats", "mp", 30, meta("turn-1"));
      await sm.setValue(sid, "stats", "name", "Hero", meta("turn-1"));

      const snapshot = await sm.getTableSnapshot(sid, "stats");
      expect(snapshot).toEqual({ hp: 80, mp: 30, name: "Hero" });
    });
  });

  describe("default values", () => {
    it("should return field defaults before any setValue", async () => {
      await sm.createTable(sid, hpSchema);
      expect(await sm.getValue(sid, "stats", "hp")).toBe(100);
      expect(await sm.getValue(sid, "stats", "mp")).toBe(50);
      expect(await sm.getValue(sid, "stats", "name")).toBeUndefined();
    });
  });

  describe("change history", () => {
    it("should record all changes in order", async () => {
      await sm.createTable(sid, hpSchema);
      await sm.setValue(sid, "stats", "hp", 90, meta("turn-1"));
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-2"));
      await sm.setValue(sid, "stats", "hp", 70, meta("turn-3"));

      const log = await sm.getChangeLog(sid, "stats", "hp");
      expect(log).toHaveLength(3);
      expect(log[0]!.value).toBe(90);
      expect(log[1]!.value).toBe(80);
      expect(log[2]!.value).toBe(70);
    });
  });

  describe("sliding window", () => {
    it("should keep only the last windowSize entries", async () => {
      sm = createStateManager(createMemoryStore(), {
        windowSize: 2,
        keepSessionBoundary: false,
      });
      await sm.createTable(sid, hpSchema);
      await sm.setValue(sid, "stats", "hp", 90, meta("turn-1"));
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-2"));
      await sm.setValue(sid, "stats", "hp", 70, meta("turn-3"));

      const log = await sm.getChangeLog(sid, "stats", "hp");
      expect(log).toHaveLength(2);
      expect(log[0]!.value).toBe(80);
      expect(log[1]!.value).toBe(70);
    });
  });

  describe("session boundary preserved", () => {
    it("should keep the initial default value entry when keepSessionBoundary=true", async () => {
      sm = createStateManager(createMemoryStore(), {
        windowSize: 2,
        keepSessionBoundary: true,
      });
      await sm.createTable(sid, hpSchema);
      // Default value (100) is the session boundary
      await sm.setValue(sid, "stats", "hp", 90, meta("turn-1"));
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-2"));
      await sm.setValue(sid, "stats", "hp", 70, meta("turn-3"));

      const log = await sm.getChangeLog(sid, "stats", "hp");
      // session boundary (default 100) + last 2 = 3 entries
      expect(log).toHaveLength(3);
      expect(log[0]!.value).toBe(100);
      expect(log[1]!.value).toBe(80);
      expect(log[2]!.value).toBe(70);
    });
  });

  describe("getChangesByTurn", () => {
    it("should return only changes from the specified turn", async () => {
      await sm.createTable(sid, hpSchema);
      await sm.setValue(sid, "stats", "hp", 90, meta("turn-1"));
      await sm.setValue(sid, "stats", "mp", 40, meta("turn-1"));
      await sm.setValue(sid, "stats", "hp", 80, meta("turn-2"));

      const turn1Changes = await sm.getChangesByTurn(sid, "turn-1");
      expect(turn1Changes).toHaveLength(2);
      expect(turn1Changes.every((c) => c.turnId === "turn-1")).toBe(true);

      const turn2Changes = await sm.getChangesByTurn(sid, "turn-2");
      expect(turn2Changes).toHaveLength(1);
      expect(turn2Changes[0]!.value).toBe(80);
    });
  });

  describe("session isolation", () => {
    it("should not share state between sessions", async () => {
      const sid2 = "session-2";
      await sm.createTable(sid, hpSchema);
      await sm.createTable(sid2, hpSchema);
      await sm.setValue(sid, "stats", "hp", 1, meta("turn-1"));

      expect(await sm.getValue(sid, "stats", "hp")).toBe(1);
      expect(await sm.getValue(sid2, "stats", "hp")).toBe(100); // default
    });
  });

  describe("unknown table", () => {
    it("should return undefined for getValue on non-existent table", async () => {
      expect(await sm.getValue(sid, "nonexistent", "field")).toBeUndefined();
    });
  });
});
