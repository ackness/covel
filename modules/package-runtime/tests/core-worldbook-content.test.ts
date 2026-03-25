import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createWorldSeedImportDraft
} from "../../../extensions/core-worldbook/server/world-seeds.js";
import { PackageRuntime } from "../src/index.js";

describe("core-worldbook staged content", () => {
  it("exposes a localized world-seeds command through package runtime", async () => {
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
    expect(enResult?.content).toContain("Metadata locale: en");
    expect(enResult?.content).toContain("Content locale: zh-CN");
  });

  it("creates an i18n-aware import draft that preserves metadata and content locales separately", async () => {
    const draft = await createWorldSeedImportDraft({
      seedId: "legacy-cyberpunk-neon-abyss",
      locale: "en"
    });

    expect(draft.world).toEqual({
      name: "Neon Abyss: 2187",
      description:
        "In New Shanghai, megacorps divide the world while neural links and cybernetics rewrite fate."
    });
    expect(draft.artifact).toMatchObject({
      kind: "world-doc",
      mediaType: "text/markdown",
      metadata: {
        requestedLocale: "en",
        metadataLocale: "en",
        contentLocale: "zh-CN",
        seedId: "legacy-cyberpunk-neon-abyss"
      }
    });
    expect(draft.memoryDocuments.length).toBeGreaterThanOrEqual(4);
    expect(draft.memoryDocuments[0]).toMatchObject({
      sourceType: "worldbook",
      scope: "world-seed:legacy-cyberpunk-neon-abyss",
      metadata: {
        contentLocale: "zh-CN",
        requestedLocale: "en"
      }
    });
    expect(
      draft.memoryDocuments.some((document) => document.title === "世界背景")
    ).toBe(true);
  });

  it("localizes invalid world seed responses instead of leaking internal english errors", async () => {
    const runtime = new PackageRuntime({
      packagesRoot: resolve(process.cwd(), "extensions")
    });

    await runtime.discover();
    await runtime.enable("core-worldbook");

    const command = runtime.getCommand("world-seeds");

    const zhResult = await command?.execute(
      {
        _: [],
        seed: "missing-seed"
      },
      {
        locale: "zh-CN"
      }
    );
    const enResult = await command?.execute(
      {
        _: [],
        seed: "missing-seed"
      },
      {
        locale: "en"
      }
    );

    expect(zhResult?.content).toContain("未找到世界种子");
    expect(enResult?.content).toContain("Unknown world seed");
  });
});
