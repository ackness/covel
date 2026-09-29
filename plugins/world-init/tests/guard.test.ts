import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";

import guard from "../guard.js";

function context(
  worldRecord: unknown,
  characterSchema: unknown = null,
  entries: unknown[] = [],
  locale = "en-US",
) {
  return {
    sessionId: "session",
    turnId: "turn",
    pluginId: "world-init",
    runtimeId: "world-init/schema-gen",
    locale,
    world: { worldRecord, characterSchema, characters: [] },
    store: { listPluginData: async () => entries },
  };
}

describe("world-init schema guard", () => {
  it("reuses the authoritative session schema without regenerating it", async () => {
    const schema = { version: 2, types: ["enemy"], attributes: [] };
    const result = await guard(
      context(null, schema, [{ key: "geography", value: {} }]),
    );
    expect(getToolContent(result)).toMatchObject({
      skip: true,
      preGameDone: true,
      worldSchema: schema,
    });
    expect(getPendingProposals(result)).toEqual([]);
  });
  it("derives locale-aware fields from authored dimensions and buffers both writes", async () => {
    const world = {
      metadata: {
        dimensions: {
          economy: { currencies: [{ name: { ja: "円", "en-US": "Yen" } }] },
          powerSystem: {
            name: { ja: "魔法階級", "en-US": "Magic rank" },
            tiers: [{ name: { ja: "見習い", "en-US": "Apprentice" } }],
          },
        },
      },
    };
    for (const [locale, currency, tier] of [
      ["ja-JP", "円", "見習い"],
      ["zh-Hant-TW", "Yen", "Apprentice"],
    ]) {
      const result = await guard(context(world, null, [], locale));
      expect(getToolContent(result)).toMatchObject({
        skip: true,
        importedDimensions: true,
      });
      const proposals = getPendingProposals(result);
      expect(proposals.map((proposal) => proposal.type)).toEqual([
        "character.schema.set",
        "plugin.data.batch",
      ]);
      const attributes = proposals[0].payload.attributes;
      expect(attributes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: currency }),
          expect.objectContaining({ id: "powerTier", defaultValue: tier }),
        ]),
      );
    }
  });
  it("uses declared character types and attributes when importing an uninitialized world", async () => {
    const declared = {
      types: ["spirit"],
      attributes: [
        { id: "energy", name: "Energy", type: "number", category: "stats" },
      ],
    };
    const result = await guard(
      context({ metadata: { characterSchema: declared } }),
    );
    expect(getPendingProposals(result)[0]).toMatchObject({
      type: "character.schema.set",
      payload: declared,
    });
  });
  it("lets the model generate a schema when the world declares no usable data", async () => {
    expect(await guard(context({ metadata: {} }))).toEqual({
      skip: false,
      initialized: false,
    });
  });
});
