import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { dimensionRecordSchema } from "@covel/shared";
import {
  DIMENSION_LOCALE_BACKUP_NAMESPACE,
  repairSessionDimensionLocale,
} from "../../src/routes/api/session/dimension-locale-repair.js";

const at = "2026-10-01T00:00:00Z";
const name = { "zh-CN": "潮币", "en-US": "Tide Coin" };
const schema = {
  type: "object",
  properties: { name: { type: "string", "x-i18n": true } },
};
// What a session stored before its state held one language.
const withMaps = {
  definition: {
    name: "Economy",
    schema,
    initialValue: { name },
    updateRule: { "zh-CN": "交易后更新。", "en-US": "Update after a trade." },
  },
  value: { name },
  version: 2,
};

async function sessionWith(id: string, records: Record<string, unknown>) {
  const store = createMemoryStore();
  await store.createSession({
    id,
    worldId: "mistport",
    phase: "playing",
    status: "active",
    setupRuntimes: {},
    completedPlayerTurns: 5,
    metadata: { _dimensionProviderPluginId: "world-init" },
    locale: "zh-CN",
    activePlugins: ["world-init"],
    createdAt: at,
    updatedAt: at,
  });
  for (const [key, value] of Object.entries(records)) {
    await store.setPluginData({
      id: `${id}-${key}`,
      sessionId: id,
      pluginId: "world-init",
      namespace: "_dimensions",
      key,
      value,
      createdAt: at,
      updatedAt: at,
    });
  }
  const session = (await store.getSession(id))!;
  const rows = async (namespace: string) =>
    Object.fromEntries(
      (await store.listPluginData(id, "world-init", namespace)).map((row) => [
        row.key,
        row.value,
      ]),
    );
  return { store, session, rows };
}

describe("dimension records that stored locale maps", () => {
  it("rewrites them in the session's language and keeps the originals", async () => {
    const current = {
      definition: {
        name: "Tone",
        schema: { type: "string" },
        initialValue: "",
      },
      value: "grim",
      version: 1,
    };
    const { store, session, rows } = await sessionWith("repair-1", {
      economy: withMaps,
      tone: current,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await repairSessionDimensionLocale(store, session)).toEqual([
      "economy",
    ]);

    const dimensions = await rows("_dimensions");
    expect(dimensionRecordSchema.parse(dimensions.economy)).toMatchObject({
      definition: {
        initialValue: { name: "潮币" },
        updateRule: "交易后更新。",
      },
      value: { name: "潮币" },
      version: 2,
    });
    expect(dimensions.tone).toEqual(current);
    expect(await rows(DIMENSION_LOCALE_BACKUP_NAMESPACE)).toEqual({
      economy: withMaps,
    });
    // A second look changes nothing.
    expect(await repairSessionDimensionLocale(store, session)).toEqual([]);
  });

  it("leaves a record that is invalid for another reason", async () => {
    const damaged = { ...withMaps, version: 0 };
    const { store, session, rows } = await sessionWith("repair-2", {
      economy: damaged,
    });
    expect(await repairSessionDimensionLocale(store, session)).toEqual([]);
    expect((await rows("_dimensions")).economy).toEqual(damaged);
    expect(await rows(DIMENSION_LOCALE_BACKUP_NAMESPACE)).toEqual({});
  });
});
