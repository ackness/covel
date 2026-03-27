import type {
  PackageContextFragment,
  PackageContextProviderExecutionContext,
  PackageContextProviderInput
} from "../../../modules/package-runtime/src/index.js";
import { pickLocalizedText } from "../../shared/locale.js";
import {
  createWorldSeedImportDraft,
  listWorldSeedSummaries
} from "./world-seeds.js";

export const contextProvider = {
  id: "worldbook-context",
  async build(
    input: PackageContextProviderInput,
    context: PackageContextProviderExecutionContext
  ): Promise<PackageContextFragment[]> {
    const world = context.world;
    if (!world) {
      return [];
    }

    const fragments: PackageContextFragment[] = [
      {
        id: `world-overview:${world.id}`,
        title: pickLocalizedText(input.locale, {
          "zh-CN": "世界设定",
          en: "World facts"
        }),
        content: [
          `${pickLocalizedText(input.locale, { "zh-CN": "名称", en: "Name" })}: ${world.name}`,
          `${pickLocalizedText(input.locale, { "zh-CN": "描述", en: "Description" })}: ${world.description}`
        ].join("\n"),
        priority: 95,
        channel: "reference",
        pinned: true
      }
    ];

    const matchingSeed = findMatchingWorldSeed(world.name);
    if (!matchingSeed) {
      return fragments;
    }

    const draft = await createWorldSeedImportDraft({
      seedId: matchingSeed.id,
      locale: input.locale
    });
    const sectionSummary = draft.memoryDocuments
      .slice(0, 3)
      .map((document) => `## ${document.title}\n${truncate(document.content, 260)}`)
      .join("\n\n");

    fragments.push({
      id: `world-seed:${matchingSeed.id}`,
      title: pickLocalizedText(input.locale, {
        "zh-CN": "世界书摘录",
        en: "Worldbook excerpts"
      }),
      content: [
        `${pickLocalizedText(input.locale, { "zh-CN": "世界种子", en: "World seed" })}: ${matchingSeed.name}`,
        sectionSummary
      ].join("\n\n"),
      priority: 88,
      channel: "reference"
    });

    return fragments;
  }
};

export default contextProvider;

function findMatchingWorldSeed(worldName: string) {
  const normalizedWorldName = normalizeValue(worldName);

  return [
    ...listWorldSeedSummaries("zh-CN"),
    ...listWorldSeedSummaries("en")
  ].find((seed) => normalizeValue(seed.name) === normalizedWorldName) ?? null;
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}…`
    : value;
}
