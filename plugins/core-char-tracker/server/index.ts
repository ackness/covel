import type { PluginRegistrar, RuntimeHandlerContext, RuntimeHandlerResult } from "@covel/plugin-runtime";
import type { CharacterCard, CharacterType, RuntimeContextView } from "@covel/shared";

export default function register(registrar: PluginRegistrar) {
  registrar.addRuntimeHandler("char-tracker", charTrackerHandler);
}

const PLUGIN_ID = "core-char-tracker";

interface TrackerExtension {
  firstSeenTurn: string;
  lastSeenTurn: string;
  mood?: string;
  mentionCount: number;
}

/**
 * Analyze the narrative from the current turn and extract character mentions.
 *
 * Uses simple heuristics:
 * - Chinese: quoted names, or patterns like X said/X laughed
 * - English: capitalized proper nouns with speech verbs
 *
 * Emits record.upsert for each new/updated character and a state.patch with the full character list.
 * Structures records to match CharacterCard and tracks relationships.
 */
async function charTrackerHandler(
  ctx: RuntimeHandlerContext
): Promise<RuntimeHandlerResult> {
  const context = ctx.context as RuntimeContextView;
  const narrative = context.narrative?.content ?? "";
  if (!narrative) return { proposals: [] };

  const isZh = ctx.locale.startsWith("zh");
  const turnId = context.run.turnId;

  const existingCards = (context.characters ?? []) as CharacterCard[];
  const knownByName = new Map<string, CharacterCard>();
  for (const card of existingCards) {
    knownByName.set(card.name, card);
  }

  const extracted = isZh
    ? extractChineseNames(narrative)
    : extractEnglishNames(narrative);

  if (extracted.length === 0) return { proposals: [] };

  const proposals: Array<{ kind: string; payload: unknown }> = [];
  const updatedChars: Record<string, CharacterCard> = {};
  for (const card of existingCards) {
    updatedChars[card.name] = card;
  }

  for (const name of extracted) {
    const existing = knownByName.get(name);
    if (existing) {
      const ext = (existing.extensions[PLUGIN_ID] ?? {}) as TrackerExtension;
      const updatedExt: TrackerExtension = {
        ...ext,
        lastSeenTurn: turnId,
        mentionCount: (ext.mentionCount ?? 0) + 1,
      };
      const updatedCard: CharacterCard = {
        ...existing,
        extensions: {
          ...existing.extensions,
          [PLUGIN_ID]: updatedExt,
        },
        version: existing.version + 1,
      };
      updatedChars[name] = updatedCard;

      proposals.push({
        kind: "record.upsert",
        payload: {
          key: `character:${name}`,
          recordType: "character",
          value: updatedCard,
        },
      });
    } else {
      const charType: CharacterType = inferRole(name, narrative, isZh) === "protagonist" ? "companion" : "npc";
      const trackerExt: TrackerExtension = {
        firstSeenTurn: turnId,
        lastSeenTurn: turnId,
        mentionCount: 1,
      };
      const card: CharacterCard = {
        id: "",
        worldId: context.run.worldId ?? "",
        runId: context.run.runId,
        name,
        type: charType,
        description: inferDescription(name, narrative, isZh),
        fields: {},
        extensions: {
          [PLUGIN_ID]: trackerExt,
        },
        createdAt: new Date().toISOString(),
        version: 1,
      };
      updatedChars[name] = card;

      proposals.push({
        kind: "record.upsert",
        payload: {
          key: `character:${name}`,
          recordType: "character",
          value: card,
        },
      });
    }
  }

  // Detect co-occurrence relationships between characters mentioned in same narrative
  if (extracted.length > 1) {
    for (let i = 0; i < extracted.length; i++) {
      for (let j = i + 1; j < extracted.length; j++) {
        proposals.push({
          kind: "record.upsert",
          payload: {
            key: `rel:${extracted[i]}:${extracted[j]}`,
            recordType: "character_relationship",
            value: {
              fromCharacterName: extracted[i],
              toCharacterName: extracted[j],
              type: "acquaintance",
              lastInteractionTurnId: turnId,
            },
          },
        });
      }
    }
  }

  proposals.push({
    kind: "state.patch",
    payload: {
      characters: updatedChars,
    },
  });

  return { proposals };
}

function extractChineseNames(text: string): string[] {
  const names = new Set<string>();

  const speechPattern = /([^\s，。！？、：""''（）\n]{2,4})(说|道|问|答|笑|叹|喊|叫|低声|冷声|沉声|点头|摇头|看向)/g;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    const name = match[1];
    if (!isCommonPhrase(name)) {
      names.add(name);
    }
  }

  return Array.from(names);
}

function extractEnglishNames(text: string): string[] {
  const names = new Set<string>();

  const speechPattern = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(said|asked|replied|whispered|shouted|laughed|nodded|shook|looked|turned|smiled)/g;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    names.add(match[1]);
  }

  return Array.from(names);
}

function inferRole(
  name: string,
  narrative: string,
  isZh: boolean
): "protagonist" | "npc" | "unknown" {
  if (isZh && narrative.includes("你")) {
    return "npc";
  }
  if (!isZh && /\byou\b/i.test(narrative)) {
    return "npc";
  }
  return "unknown";
}

function inferDescription(name: string, narrative: string, isZh: boolean): string {
  const sentences = narrative.split(/[。.!！？?]/);
  for (const sentence of sentences) {
    if (sentence.includes(name) && sentence.length > 10 && sentence.length < 100) {
      return sentence.trim();
    }
  }
  return isZh ? `在叙事中出现的角色` : `A character mentioned in the narrative`;
}

function isCommonPhrase(text: string): boolean {
  const common = [
    "但是", "因为", "然后", "所以", "如果", "虽然", "已经", "可以", "应该",
    "不过", "只是", "这里", "那里", "他们", "她们", "我们", "你们",
    "这个", "那个", "什么", "怎么", "为什么", "一个", "一些",
  ];
  return common.includes(text);
}
