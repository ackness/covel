import { describe, expect, it } from "vitest";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  parseSettingsPersistenceBundle,
} from "../src/settings-persistence/schema.js";

describe("settings persistence schema", () => {
  it("reads the current bundle without changing its revision", () => {
    expect(
      parseSettingsPersistenceBundle({
        schemaVersion: 2,
        revision: 4,
        savedAt: "saved",
        entries: { "ui.locale": "en-US" },
      }),
    ).toEqual({
      schemaVersion: 2,
      revision: 4,
      savedAt: "saved",
      entries: { "ui.locale": "en-US" },
    });
  });

  it.each([undefined, 1, 3])(
    "rejects unsupported version %s",
    (schemaVersion) => {
      expect(() =>
        parseSettingsPersistenceBundle({
          ...(schemaVersion === undefined ? {} : { schemaVersion }),
          savedAt: "saved",
          entries: { "ui.locale": "en-US" },
        }),
      ).toThrow(/unsupported/);
    },
  );

  it("rejects corrupt, incomplete, and future bundles", () => {
    expect(() => parseSettingsPersistenceBundle({ schemaVersion: 2 })).toThrow(
      /v2 bundle/,
    );
    expect(() =>
      parseSettingsPersistenceBundle({
        schemaVersion: 2,
        revision: 0,
        savedAt: "",
        entries: [],
      }),
    ).toThrow(/v2 bundle/);
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
