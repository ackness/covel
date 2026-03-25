import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createWorldSeedImportDraft,
  listWorldSeedSummaries
} from "../../../extensions/core-worldbook/server/world-seeds.js";
import { PackageRuntime } from "../src/index.js";

describe("core-worldbook staged world seeds", () => {
  it("exposes a localized package command for staged world seeds", async () => {
    const runtime = new PackageRuntime({
      packagesRoot: resolve(process.cwd(), "extensions")
    });

    await runtime.discover();
    await runtime.enable("core-worldbook");

    const command = runtime.getCommand("world-seeds");

    expect(command).toMatchObject({
      packageName: "core-worldbook"
    });

    const zhResult = await command?.execute(
      {
        _: []
      },
      {
        locale: "zh-CN"
      }
    );
    const enResult = await command?.execute(
      {
        _: [],
        seed: "legacy-wuxia-nine-provinces"
      },
      {
        locale: "en"
      }
    );

    expect(zhResult).toMatchObject({
      content: expect.stringContaining("已暂存 3 个世界种子")
    });
    expect(zhResult?.content).toContain("九州江湖录");
    expect(enResult).toMatchObject({
      content: expect.stringContaining("Chronicle of the Nine Provinces")
    });
    expect(enResult?.content).toContain("Content locale: zh-CN");
  });

  it("builds an i18n-aware import draft that separates metadata locale from content locale", async () => {
    const summaries = listWorldSeedSummaries("en");

    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "legacy-cyberpunk-neon-abyss",
          name: "Neon Abyss: 2187",
          metadataLocale: "en",
          contentLocale: "zh-CN"
        })
      ])
    );

    const draft = await createWorldSeedImportDraft({
      seedId: "legacy-cyberpunk-neon-abyss",
      locale: "en"
    });

    expect(draft.world).toEqual({
      name: "Neon Abyss: 2187",
      description:
        "In New Shanghai, megacorps divide the world while neural links and cybernetics rewrite fate."
    });
    expect(draft.artifact.metadata).toMatchObject({
      seedId: "legacy-cyberpunk-neon-abyss",
      requestedLocale: "en",
      metadataLocale: "en",
      contentLocale: "zh-CN"
    });
    expect(draft.memoryDocuments.map((document) => document.title)).toEqual(
      expect.arrayContaining([
        "世界背景",
        "神经链",
        "义体改造",
        "黑客技术",
        "势力",
        "核心冲突",
        "叙事风格",
        "运行时拆分建议",
        "重要 NPC 种子"
      ])
    );
    expect(draft.memoryDocuments.length).toBeGreaterThanOrEqual(9);
    expect(draft.memoryDocuments[0]).toMatchObject({
      sourceType: "worldbook",
      scope: "world-seed:legacy-cyberpunk-neon-abyss",
      metadata: {
        kind: "world-seed-section",
        requestedLocale: "en",
        metadataLocale: "en",
        contentLocale: "zh-CN"
      },
      provenance: {
        sourceProject: "../ai-gamestudio-dev",
        sourcePath: "templates/worlds/cyberpunk.md"
      }
    });
  });
});
