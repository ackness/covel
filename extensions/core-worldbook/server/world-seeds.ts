import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_LOCALE, type SupportedLocale } from "../../../modules/contracts/src/index.js";
import { getLocale } from "../../shared/locale.js";

export interface WorldSeedLocalizedMetadata {
  name: string;
  description: string;
}

export interface WorldSeedSummary {
  id: string;
  genre: string;
  tags: string[];
  name: string;
  description: string;
  requestedLocale: SupportedLocale;
  metadataLocale: SupportedLocale;
  contentLocale: SupportedLocale;
  legacyCapabilityHints: string[];
}

export interface WorldSeedImportDraft {
  world: {
    name: string;
    description: string;
  };
  artifact: {
    kind: "world-doc";
    mediaType: "text/markdown";
    content: string;
    metadata: {
      seedId: string;
      requestedLocale: SupportedLocale;
      metadataLocale: SupportedLocale;
      contentLocale: SupportedLocale;
      genre: string;
      tags: string[];
      sourceProject: string;
      sourcePath: string;
      legacyCapabilityHints: string[];
    };
  };
  memoryDocuments: Array<{
    id: string;
    sourceType: "worldbook";
    scope: string;
    title: string;
    content: string;
    metadata: {
      kind: "world-seed-section";
      seedId: string;
      sectionIndex: number;
      requestedLocale: SupportedLocale;
      metadataLocale: SupportedLocale;
      contentLocale: SupportedLocale;
    };
    provenance: {
      seedId: string;
      sourceProject: string;
      sourcePath: string;
      contentLocale: SupportedLocale;
    };
  }>;
}

interface WorldSeedRecord {
  id: string;
  genre: string;
  tags: string[];
  defaultLocale: SupportedLocale;
  metadata: Record<SupportedLocale, WorldSeedLocalizedMetadata>;
  contentFiles: Partial<Record<SupportedLocale, string>>;
  sourceProject: string;
  sourcePath: string;
  legacyCapabilityHints: string[];
}

const WORLD_SEEDS: readonly WorldSeedRecord[] = [
  {
    id: "legacy-wuxia-nine-provinces",
    genre: "wuxia",
    tags: ["武侠", "古风", "江湖", "中国风"],
    defaultLocale: "zh-CN",
    metadata: {
      "zh-CN": {
        name: "九州江湖录",
        description: "大梁末年，江湖风云再起。天机卷重现武林，正邪六门蠢蠢欲动。"
      },
      en: {
        name: "Chronicle of the Nine Provinces",
        description:
          "Rival sects fight over the Heavenly Mechanism Scroll as the martial world descends into chaos."
      }
    },
    contentFiles: {
      "zh-CN": fileURLToPath(new URL("../assets/legacy/world-seeds/wuxia.md", import.meta.url))
    },
    sourceProject: "../ai-gamestudio-dev",
    sourcePath: "templates/worlds/wuxia.md",
    legacyCapabilityHints: [
      "skill-check",
      "combat",
      "inventory",
      "quest",
      "faction",
      "relationship",
      "status-effect",
      "codex"
    ]
  },
  {
    id: "legacy-cyberpunk-neon-abyss",
    genre: "cyberpunk",
    tags: ["赛博朋克", "科幻", "反乌托邦", "近未来"],
    defaultLocale: "zh-CN",
    metadata: {
      "zh-CN": {
        name: "霓虹深渊：2187",
        description: "2187 年的新上海，五大企业垄断世界，神经链与义体改造重塑人的边界。"
      },
      en: {
        name: "Neon Abyss: 2187",
        description:
          "In New Shanghai, megacorps divide the world while neural links and cybernetics rewrite fate."
      }
    },
    contentFiles: {
      "zh-CN": fileURLToPath(new URL("../assets/legacy/world-seeds/cyberpunk.md", import.meta.url))
    },
    sourceProject: "../ai-gamestudio-dev",
    sourcePath: "templates/worlds/cyberpunk.md",
    legacyCapabilityHints: [
      "skill-check",
      "combat",
      "inventory",
      "quest",
      "faction",
      "relationship",
      "status-effect",
      "codex"
    ]
  },
  {
    id: "legacy-urban-xianxia-qi-resurgence",
    genre: "urban-xianxia",
    tags: ["现代修真", "都市奇幻", "日常喜剧", "跑团设定"],
    defaultLocale: "zh-CN",
    metadata: {
      "zh-CN": {
        name: "灵气复苏：外卖小哥的修仙日常",
        description: "现代都市与复苏灵气并存，普通人被卷入隐秘修真世界。"
      },
      en: {
        name: "Qi Resurgence: A Courier's Cultivation Life",
        description:
          "A delivery rider is pulled into hidden cultivation circles as spiritual energy returns to the modern city."
      }
    },
    contentFiles: {
      "zh-CN": fileURLToPath(new URL("../assets/legacy/world-seeds/urban-xianxia.md", import.meta.url))
    },
    sourceProject: "../ai-gamestudio-dev",
    sourcePath: "templates/worlds/urban-xianxia.md",
    legacyCapabilityHints: [
      "skill-check",
      "combat",
      "inventory",
      "quest",
      "faction",
      "relationship",
      "status-effect",
      "codex"
    ]
  }
];

const WORLD_SEED_MAP = new Map(WORLD_SEEDS.map((seed) => [seed.id, seed]));

export function listWorldSeedSummaries(locale: unknown): WorldSeedSummary[] {
  return WORLD_SEEDS.map((seed) => {
    const requestedLocale = getLocale(locale);
    const metadataLocale = resolveMetadataLocale(seed, requestedLocale);
    const contentLocale = resolveContentLocale(seed, requestedLocale);
    const metadata = seed.metadata[metadataLocale];

    return {
      id: seed.id,
      genre: seed.genre,
      tags: [...seed.tags],
      name: metadata.name,
      description: metadata.description,
      requestedLocale,
      metadataLocale,
      contentLocale,
      legacyCapabilityHints: [...seed.legacyCapabilityHints]
    };
  });
}

export async function createWorldSeedImportDraft(input: {
  seedId: string;
  locale?: unknown;
}): Promise<WorldSeedImportDraft> {
  const resolved = await readWorldSeedContent(input);
  const sections = extractMarkdownSections(resolved.markdown);

  return {
    world: {
      name: resolved.metadata.name,
      description: resolved.metadata.description
    },
    artifact: {
      kind: "world-doc",
      mediaType: "text/markdown",
      content: resolved.markdown,
      metadata: {
        seedId: resolved.seed.id,
        requestedLocale: resolved.requestedLocale,
        metadataLocale: resolved.metadataLocale,
        contentLocale: resolved.contentLocale,
        genre: resolved.seed.genre,
        tags: [...resolved.seed.tags],
        sourceProject: resolved.seed.sourceProject,
        sourcePath: resolved.seed.sourcePath,
        legacyCapabilityHints: [...resolved.seed.legacyCapabilityHints]
      }
    },
    memoryDocuments: sections.map((section, index) => ({
      id: `${resolved.seed.id}:section:${String(index + 1).padStart(2, "0")}`,
      sourceType: "worldbook" as const,
      scope: `world-seed:${resolved.seed.id}`,
      title: section.title,
      content: section.content,
      metadata: {
        seedId: resolved.seed.id,
        sectionIndex: index + 1,
        requestedLocale: resolved.requestedLocale,
        metadataLocale: resolved.metadataLocale,
        contentLocale: resolved.contentLocale,
        kind: "world-seed-section" as const
      },
      provenance: {
        seedId: resolved.seed.id,
        sourceProject: resolved.seed.sourceProject,
        sourcePath: resolved.seed.sourcePath,
        contentLocale: resolved.contentLocale
      }
    }))
  };
}

export async function readWorldSeedContent(input: {
  seedId: string;
  locale?: unknown;
}): Promise<{
  seed: WorldSeedRecord;
  requestedLocale: SupportedLocale;
  metadataLocale: SupportedLocale;
  contentLocale: SupportedLocale;
  metadata: WorldSeedLocalizedMetadata;
  markdown: string;
}> {
  const seed = WORLD_SEED_MAP.get(input.seedId);
  if (!seed) {
    throw new Error(`Unknown world seed '${input.seedId}'.`);
  }

  const requestedLocale = getLocale(input.locale);
  const metadataLocale = resolveMetadataLocale(seed, requestedLocale);
  const contentLocale = resolveContentLocale(seed, requestedLocale);
  const filePath = seed.contentFiles[contentLocale];

  if (!filePath) {
    throw new Error(`World seed '${input.seedId}' has no content file for locale '${contentLocale}'.`);
  }

  return {
    seed,
    requestedLocale,
    metadataLocale,
    contentLocale,
    metadata: seed.metadata[metadataLocale],
    markdown: await readFile(filePath, "utf8")
  };
}

function resolveMetadataLocale(
  seed: WorldSeedRecord,
  requestedLocale: SupportedLocale
): SupportedLocale {
  return seed.metadata[requestedLocale] ? requestedLocale : seed.defaultLocale;
}

function resolveContentLocale(
  seed: WorldSeedRecord,
  requestedLocale: SupportedLocale
): SupportedLocale {
  if (seed.contentFiles[requestedLocale]) {
    return requestedLocale;
  }

  return seed.defaultLocale ?? DEFAULT_LOCALE;
}

function extractMarkdownSections(markdown: string): Array<{
  title: string;
  content: string;
}> {
  const body = stripFrontmatter(markdown);
  const lines = body.split("\n");
  const sections: Array<{
    title: string;
    contentLines: string[];
  }> = [];
  let currentSection: {
    title: string;
    contentLines: string[];
  } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);

    if (headingMatch) {
      if (currentSection && currentSection.contentLines.join("\n").trim().length > 0) {
        sections.push(currentSection);
      }

      currentSection = {
        title: headingMatch[2].trim(),
        contentLines: []
      };
      continue;
    }

    if (!currentSection) {
      continue;
    }

    currentSection.contentLines.push(line);
  }

  if (currentSection && currentSection.contentLines.join("\n").trim().length > 0) {
    sections.push(currentSection);
  }

  return sections.map((section) => ({
    title: section.title,
    content: section.contentLines.join("\n").trim()
  }));
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown;
  }

  const closingIndex = markdown.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    return markdown;
  }

  return markdown.slice(closingIndex + 5).trimStart();
}
