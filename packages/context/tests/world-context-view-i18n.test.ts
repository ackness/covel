import { describe, expect, it } from "vitest";
import { buildWorldContextView } from "../src/session-context-views.js";

// A WorldRecord whose dimensions mix i18n leaves with structured objects.
const worldRecord = {
  id: "w1",
  name: "W",
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  metadata: {
    dimensions: {
      tone: { "zh-CN": "压抑的雾港", "en-US": "Oppressive fog-port" },
      factions: [
        {
          id: "salt-fangs",
          type: "guild",
          name: { "zh-CN": "盐牙会", "en-US": "Salt-Fangs" },
          description: { "zh-CN": "走私帮", "en-US": "Smugglers" },
        },
      ],
      startingConditions: {
        openingScenario: { "zh-CN": "潮钟三鸣", "en-US": "Three tide-bells" },
      },
    },
  },
} as unknown as Parameters<typeof buildWorldContextView>[0]["worldRecord"];

describe("buildWorldContextView i18n localization", () => {
  it("resolves i18n dimension leaves to the session locale, preserving structure", () => {
    const view = buildWorldContextView({
      worldRecord,
      schemaMap: undefined,
      entriesMap: undefined,
      locale: "zh-CN",
    });
    const dims = view.dimensions as Record<string, any>;

    // i18n leaves resolved to the locale string…
    expect(dims.factions[0].name).toBe("盐牙会");
    expect(dims.factions[0].description).toBe("走私帮");
    // …while non-i18n structured fields are untouched.
    expect(dims.factions[0].id).toBe("salt-fangs");
    expect(dims.factions[0].type).toBe("guild");

    // tone / openingScenario (authored as i18n) now extract cleanly.
    expect(view.tone).toBe("压抑的雾港");
    expect(view.openingScenario).toBe("潮钟三鸣");
  });

  it("does not leak a raw bilingual record into the dimensions", () => {
    const view = buildWorldContextView({
      worldRecord,
      schemaMap: undefined,
      entriesMap: undefined,
      locale: "zh-CN",
    });
    const json = JSON.stringify(view.dimensions);
    expect(json).not.toContain("en-US");
    expect(json).not.toContain("Salt-Fangs");
  });

  it("falls back (language-only / first) when the exact locale is absent", () => {
    const view = buildWorldContextView({
      worldRecord,
      schemaMap: undefined,
      entriesMap: undefined,
      locale: "ja-JP",
    });
    // No ja value → first available (zh-CN).
    expect((view.dimensions as Record<string, any>).factions[0].name).toBe(
      "盐牙会",
    );
  });
});
