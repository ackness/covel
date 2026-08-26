import { describe, expect, it } from "vitest";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  parseSettingsPersistenceBundle,
} from "../src/settings-persistence/schema.js";

describe("settings persistence schema", () => {
  it("migrates a valid v1 bundle in memory", () => {
    expect(
      parseSettingsPersistenceBundle({
        schemaVersion: 1,
        savedAt: "old",
        entries: { "ui.locale": "en-US" },
      }),
    ).toEqual({
      schemaVersion: 2,
      revision: 0,
      savedAt: "old",
      entries: { "ui.locale": "en-US" },
    });
  });

  it("rejects corrupt, incomplete, and future bundles", () => {
    expect(() => parseSettingsPersistenceBundle({})).toThrow(/v1 bundle/);
    expect(() => parseSettingsPersistenceBundle({ entries: [] })).toThrow(
      /v1 bundle/,
    );
    expect(() => parseSettingsPersistenceBundle({ schemaVersion: 3 })).toThrow(
      /unsupported/,
    );
  });

  it("builds a v2 successor", () => {
    expect(nextSettingsPersistenceBundle({ a: true }, 4)).toMatchObject({
      schemaVersion: 2,
      revision: 5,
      entries: { a: true },
    });
    expect(emptySettingsPersistenceBundle()).toEqual({
      schemaVersion: 2,
      revision: 0,
      savedAt: "",
      entries: {},
    });
  });
});
