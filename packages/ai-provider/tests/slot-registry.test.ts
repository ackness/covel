import { describe, it, expect, beforeEach } from "vitest";
import { createSlotRegistry, type SlotRegistry } from "../src/slot-registry.js";

function makeDeps() {
  return {
    presetRegistry: {
      resolvePreset: (id?: string) => (id ? { id } : null),
      listPresets: () => [
        { id: "preset-a", enabled: true },
        { id: "preset-b", enabled: true },
      ],
    },
  };
}

describe("SlotRegistry (tag-aware)", () => {
  let registry: SlotRegistry;

  beforeEach(() => {
    registry = createSlotRegistry(makeDeps());
    registry.configure({
      slots: {
        ds: { slotId: "ds", presetId: "slot-ds", tag: "text" },
        qwen: { slotId: "qwen", presetId: "slot-qwen", tag: "text" },
        dalle: { slotId: "dalle", presetId: "slot-dalle", tag: "image" },
      },
    });
  });

  describe("resolveSlot", () => {
    it("should resolve a slot by name", () => {
      expect(registry.resolveSlot("ds")).toBe("slot-ds");
      expect(registry.resolveSlot("qwen")).toBe("slot-qwen");
      expect(registry.resolveSlot("dalle")).toBe("slot-dalle");
    });

    it("should return undefined for unknown slot (no fallback)", () => {
      expect(registry.resolveSlot("nonexistent")).toBeUndefined();
    });
  });

  describe("listSlotsByTag", () => {
    it("should return all text slots", () => {
      const textSlots = registry.listSlotsByTag("text");
      expect(textSlots).toHaveLength(2);
      expect(textSlots.map((s) => s.slotId)).toEqual(["ds", "qwen"]);
    });

    it("should return all image slots", () => {
      const imageSlots = registry.listSlotsByTag("image");
      expect(imageSlots).toHaveLength(1);
      expect(imageSlots[0].slotId).toBe("dalle");
    });

    it("should return empty array for unknown tag", () => {
      expect(registry.listSlotsByTag("audio")).toEqual([]);
    });
  });

  describe("getSlotTag", () => {
    it("should return tag for existing slot", () => {
      expect(registry.getSlotTag("ds")).toBe("text");
      expect(registry.getSlotTag("dalle")).toBe("image");
    });

    it("should return undefined for unknown slot", () => {
      expect(registry.getSlotTag("nonexistent")).toBeUndefined();
    });
  });

  describe("getParameterOverrides", () => {
    it("should return overrides when configured", () => {
      registry.configure({
        slots: {
          ds: {
            slotId: "ds",
            presetId: "slot-ds",
            tag: "text",
            parameterOverrides: { temperature: 0.7 },
          },
        },
      });
      expect(registry.getParameterOverrides("ds")).toEqual({ temperature: 0.7 });
    });

    it("should return undefined when no overrides", () => {
      expect(registry.getParameterOverrides("ds")).toBeUndefined();
    });
  });

  describe("listSlots", () => {
    it("should return all configured slots", () => {
      const slots = registry.listSlots();
      expect(Object.keys(slots)).toEqual(["ds", "qwen", "dalle"]);
    });

    it("should return a copy (not mutable reference)", () => {
      const slots = registry.listSlots();
      slots["hacked"] = { slotId: "hacked", presetId: "x", tag: "text" };
      expect(registry.listSlots()["hacked"]).toBeUndefined();
    });
  });

  describe("empty registry", () => {
    it("should handle unconfigured state", () => {
      const empty = createSlotRegistry(makeDeps());
      expect(empty.resolveSlot("ds")).toBeUndefined();
      expect(empty.listSlotsByTag("text")).toEqual([]);
      expect(empty.getSlotTag("ds")).toBeUndefined();
      expect(empty.listSlots()).toEqual({});
    });
  });
});
