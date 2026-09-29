import { describe, expect, it } from "vitest";
import {
  validateWorldIRV1,
  WORLD_IR_V1_JSON_SCHEMA,
  WORLD_IR_V1_SCHEMA_URI,
} from "../schemas/world-ir.js";
describe("world IR validation", () => {
  it("publishes one canonical JSON Schema for the WorldIR URI", () => {
    expect(WORLD_IR_V1_JSON_SCHEMA.$id).toBe(WORLD_IR_V1_SCHEMA_URI);
    expect(Object.isFrozen(WORLD_IR_V1_JSON_SCHEMA.properties.entities)).toBe(
      true,
    );
  });

  it("rejects duplicate WorldIR ids and dangling entity references", () => {
    const result = validateWorldIRV1({
      schemaVersion: 1,
      entities: [{ id: "alice", type: "character" }],
      relations: [
        {
          id: "alice",
          type: "TRUSTS",
          from: "alice",
          to: "missing",
        },
      ],
      events: [],
      statements: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.code)).toEqual(
        expect.arrayContaining(["duplicate_id", "dangling_reference"]),
      );
    }
  });

  it("rejects deeply nested attributes without overflowing the stack", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 3_000; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() =>
      validateWorldIRV1({
        schemaVersion: 1,
        entities: [{ id: "deep", type: "concept", attributes: { root } }],
        relations: [],
        events: [],
        statements: [],
      }),
    ).not.toThrow();
    const result = validateWorldIRV1({
      schemaVersion: 1,
      entities: [{ id: "deep", type: "concept", attributes: { root } }],
      relations: [],
      events: [],
      statements: [],
    });
    expect(result).toEqual(
      expect.objectContaining({
        valid: false,
        errors: [expect.objectContaining({ code: "too_deep" })],
      }),
    );
  });

  it("returns a diagnostic for hostile values instead of throwing", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("blocked ownKeys");
        },
      },
    );

    expect(() => validateWorldIRV1(hostile)).not.toThrow();
    expect(validateWorldIRV1(hostile)).toMatchObject({
      valid: false,
      errors: [{ code: "inspection_failed" }],
    });
  });

  it("enforces bounded collection sizes in both canonical validators", () => {
    const tooManyEntities = {
      schemaVersion: 1,
      entities: Array.from({ length: 33 }, (_, index) => ({
        id: `entity-${index}`,
        type: "concept",
      })),
      relations: [],
      events: [],
      statements: [],
    };

    expect(validateWorldIRV1(tooManyEntities)).toMatchObject({ valid: false });
    expect(WORLD_IR_V1_JSON_SCHEMA.properties.entities.maxItems).toBe(32);
  });
});
