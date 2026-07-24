import { describe, expect, it } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

function ctx(manualPayload) {
  return {
    sessionId: "sess-blueprint",
    turnId: "turn-blueprint",
    pluginId: "character-blueprint",
    runtimeId: "character-blueprint/import",
    playerMessage: "",
    completedResults: new Map(),
    config: {},
    manualPayload,
  };
}

// Deliberate change: handler migrated to envelope-v1, so the business return
// is under `result.value`; pending proposals stay on the envelope (result).
describe("character-blueprint handler", () => {
  it("imports a blueprint into plugin data", async () => {
    const result = await handler(
      ctx({
        blueprint: {
          schemaVersion: 1,
          id: "mentor-lin",
          name: "Lin Yue",
          role: "npc",
          persona: { summary: "A precise sword mentor." },
        },
      }),
    );

    expect(result.value).toEqual({
      imported: true,
      blueprintId: "mentor-lin",
      instantiated: false,
    });

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      sessionId: "sess-blueprint",
      turnId: "turn-blueprint",
      source: {
        pluginId: "character-blueprint",
        runtimeId: "character-blueprint/import",
      },
      payload: {
        namespace: "blueprints",
        key: "mentor-lin",
        value: {
          blueprint: {
            schemaVersion: 1,
            id: "mentor-lin",
            name: "Lin Yue",
            role: "npc",
            persona: { summary: "A precise sword mentor." },
          },
        },
      },
    });
    expect(proposals[0].payload.value.importedAt).toEqual(expect.any(String));
  });

  it("imports and instantiates through character.upsert", async () => {
    const result = await handler(
      ctx({
        instantiate: true,
        blueprint: {
          schemaVersion: 1,
          id: "mentor-lin",
          name: "Lin Yue",
          role: "npc",
          description: "A cautious sword mentor.",
          attributes: { realm: "Foundation" },
          dialogueExamples: [
            {
              user: "I can win quickly.",
              character: "Quickly is where errors hide.",
            },
          ],
          instantiate: {
            characterId: "char-lin-yue",
            fields: { realm: "Golden Core" },
            mirrorPluginId: "other-plugin",
          },
        },
      }),
    );

    expect(result.value).toEqual({
      imported: true,
      blueprintId: "mentor-lin",
      instantiated: true,
      characterId: "sess-blueprint-char-lin-yue",
    });

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      source: {
        pluginId: "character-blueprint",
        runtimeId: "character-blueprint/import",
      },
      payload: {
        namespace: "blueprints",
        key: "mentor-lin",
        value: {
          instantiatedCharacterId: "sess-blueprint-char-lin-yue",
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "character.upsert",
      source: {
        pluginId: "character-blueprint",
        runtimeId: "character-blueprint/import",
      },
      payload: {
        id: "sess-blueprint-char-lin-yue",
        name: "Lin Yue",
        type: "npc",
        description: "A cautious sword mentor.",
        fields: { realm: "Golden Core" },
        version: 1,
        mirrorPluginId: "character-blueprint",
        mirrorPluginIds: ["char-creator"],
      },
    });
    expect(proposals[1].payload.createdAt).toEqual(expect.any(String));
  });

  it("imports from blueprintJson for json-render panels", async () => {
    const result = await handler(
      ctx({
        instantiate: true,
        blueprintJson: JSON.stringify({
          schemaVersion: 1,
          id: "json-mentor",
          name: "Json Mentor",
          role: "npc",
        }),
      }),
    );

    expect(result.value).toEqual({
      imported: true,
      blueprintId: "json-mentor",
      instantiated: true,
      characterId: "sess-blueprint-char-json-mentor",
    });
    const proposals = getPendingProposals(result);
    expect(proposals.map((proposal) => proposal.type)).toEqual([
      "plugin.data",
      "character.upsert",
    ]);
  });

  it("imports from structured blueprint form payloads", async () => {
    const result = await handler(
      ctx({
        instantiate: true,
        blueprintForm: {
          id: "kamishiro-mio",
          name: "神代澪",
          role: "npc",
          description: "二年 B 组班长兼文艺部部长。",
          aliasesText: "澪, 班长",
          tagsText: "classmate, literature-club",
          traitsText: "礼貌, 慢热",
          goalsText: "保住文艺部活动室, 完成学园祭特刊",
          personaSummary: "温柔克制的优等生。",
          voice: "说话轻，句子完整。",
          style: "用整理纸张掩饰紧张。",
          club: "文艺部",
          className: "二年 B 组",
          relationshipStage: "初识",
        },
      }),
    );

    expect(result.value).toMatchObject({
      imported: true,
      blueprintId: "kamishiro-mio",
      instantiated: true,
      characterId: "sess-blueprint-npc-kamishiro-mio",
    });
    const proposals = getPendingProposals(result);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "blueprints",
        key: "kamishiro-mio",
        value: {
          blueprint: {
            id: "kamishiro-mio",
            name: "神代澪",
            description: "二年 B 组班长兼文艺部部长。",
            aliases: ["澪", "班长"],
            tags: ["classmate", "literature-club"],
            attributes: {
              club: "文艺部",
              class: "二年 B 组",
              relationshipStage: "初识",
            },
            persona: {
              summary: "温柔克制的优等生。",
              traits: ["礼貌", "慢热"],
              goals: ["保住文艺部活动室", "完成学园祭特刊"],
              voice: "说话轻，句子完整。",
              style: "用整理纸张掩饰紧张。",
            },
            instantiate: {
              characterId: "npc-kamishiro-mio",
              type: "npc",
            },
          },
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "character.upsert",
      payload: {
        id: "sess-blueprint-npc-kamishiro-mio",
        name: "神代澪",
        type: "npc",
      },
    });
  });

  it("keeps structured form imports as blueprints when instantiate is omitted", async () => {
    const result = await handler(
      ctx({
        blueprintForm: {
          id: "kamishiro-mio",
          name: "神代澪",
          role: "npc",
          characterId: "npc-mio",
          personaSummary: "温柔克制的优等生。",
        },
      }),
    );

    expect(result.value).toEqual({
      imported: true,
      blueprintId: "kamishiro-mio",
      instantiated: false,
    });
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.value.blueprint).not.toHaveProperty(
      "instantiate",
    );
  });

  it("keeps structured form imports as blueprints when instantiate is false", async () => {
    const result = await handler(
      ctx({
        instantiate: false,
        blueprintForm: {
          id: "kamishiro-mio",
          name: "神代澪",
          role: "npc",
          characterId: "npc-mio",
          personaSummary: "温柔克制的优等生。",
        },
      }),
    );

    expect(result.value).toEqual({
      imported: true,
      blueprintId: "kamishiro-mio",
      instantiated: false,
    });
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "blueprints",
        key: "kamishiro-mio",
        value: {
          blueprint: {
            id: "kamishiro-mio",
            name: "神代澪",
            persona: { summary: "温柔克制的优等生。" },
          },
        },
      },
    });
    expect(proposals[0].payload.value.blueprint).not.toHaveProperty(
      "instantiate",
    );
  });

  it("does not double-prefix generated character ids when form ids are generated", async () => {
    const result = await handler(
      ctx({
        instantiate: true,
        blueprintForm: {
          name: "Transfer Student",
          role: "npc",
        },
      }),
    );

    expect(result.value).toMatchObject({
      imported: true,
      blueprintId: "npc-transfer-student",
      instantiated: true,
      characterId: "sess-blueprint-npc-transfer-student",
    });
    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value.blueprint.instantiate.characterId).toBe(
      "npc-transfer-student",
    );
  });

  it("generates short blueprint ids when structured forms leave id blank", async () => {
    const result = await handler(
      ctx({
        instantiate: false,
        blueprintForm: {
          name: "Transfer Student",
          role: "npc",
        },
      }),
    );

    expect(result.value).toMatchObject({
      imported: true,
      blueprintId: "npc-transfer-student",
      instantiated: false,
    });
  });

  it("rejects malformed blueprintJson payloads", async () => {
    await expect(handler(ctx({ blueprintJson: "{bad json" }))).rejects.toThrow(
      "manualPayload.blueprintJson must be valid JSON",
    );
  });

  it("rejects malformed blueprint payloads", async () => {
    await expect(
      handler(ctx({ blueprint: { id: "missing-name" } })),
    ).rejects.toThrow("blueprint.name must be a non-empty string");
  });

  it("rejects unsafe ids and oversized blueprint payloads", async () => {
    await expect(
      handler(
        ctx({
          blueprint: { schemaVersion: 1, id: "../escape", name: "Escape" },
        }),
      ),
    ).rejects.toThrow("blueprint.id must be 1-128 characters");

    await expect(
      handler(
        ctx({
          blueprint: {
            schemaVersion: 1,
            id: "large-blueprint",
            name: "Large Blueprint",
            attributes: { text: "x".repeat(70_000) },
          },
        }),
      ),
    ).rejects.toThrow("blueprint is too large");
  });
});
