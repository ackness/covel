import type { CharacterCard, CharacterType } from "@covel/shared";

// ── Types ─────────────────────────────────────────────────────────

export interface TrackerExtension {
  firstSeenTurn: string;
  lastSeenTurn: string;
  mood?: string;
  mentionCount: number;
}

export interface CharacterUpsertPayload {
  key: string;
  recordType: string;
  value: CharacterCard;
}

export interface RelationshipUpsertPayload {
  key: string;
  recordType: string;
  value: {
    fromCharacterName: string;
    toCharacterName: string;
    type: string;
    lastInteractionTurnId: string;
  };
}

// ── Constants ─────────────────────────────────────────────────────

export const PLUGIN_ID = "core-char-tracker";

const COMMON_PHRASES = [
  "但是", "因为", "然后", "所以", "如果", "虽然", "已经", "可以", "应该",
  "不过", "只是", "这里", "那里", "他们", "她们", "我们", "你们",
  "这个", "那个", "什么", "怎么", "为什么", "一个", "一些",
] as const;

// ── Pure Functions ────────────────────────────────────────────────

/** Check whether a short Chinese string is a common phrase rather than a name. */
export function isCommonPhrase(text: string): boolean {
  return (COMMON_PHRASES as readonly string[]).includes(text);
}

/**
 * Extract likely character names from Chinese narrative text.
 * Uses speech-verb patterns like "X说道", "X问", etc.
 */
export function extractChineseNames(text: string): string[] {
  const names = new Set<string>();

  const speechPattern = /([^\s，。！？、：""''（）\n]{2,4})(说|道|问|答|笑|叹|喊|叫|低声|冷声|沉声|点头|摇头|看向)/g;
  // Functional prefixes that are not part of character names
  const functionalPrefixes = /^[一的了在从向对把被让给跟到往是又也还就才只都已于旁边]/;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    let name = match[1];
    // Strip leading functional characters
    while (name.length > 2 && functionalPrefixes.test(name)) {
      name = name.slice(1);
    }
    if (!isCommonPhrase(name)) {
      names.add(name);
    }
  }

  return Array.from(names);
}

/**
 * Extract likely character names from English narrative text.
 * Uses capitalized proper nouns followed by speech verbs.
 */
export function extractEnglishNames(text: string): string[] {
  const names = new Set<string>();

  const speechPattern = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(said|asked|replied|whispered|shouted|laughed|nodded|shook|looked|turned|smiled)/g;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    names.add(match[1]);
  }

  return Array.from(names);
}

/**
 * Infer whether a character is a protagonist or NPC based on narrative.
 * If the narrative addresses "you" (你/you), other named characters are NPCs.
 */
export function inferRole(
  _name: string,
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

/**
 * Extract a short description for a character from the narrative.
 * Finds the first sentence mentioning the character that is between 10-100 chars.
 */
export function inferDescription(name: string, narrative: string, isZh: boolean): string {
  const sentences = narrative.split(/[。.!！？?]/);
  for (const sentence of sentences) {
    if (sentence.includes(name) && sentence.length > 10 && sentence.length < 100) {
      return sentence.trim();
    }
  }
  return isZh ? `在叙事中出现的角色` : `A character mentioned in the narrative`;
}

// ── Character Card Building ───────────────────────────────────────

/** Build an updated CharacterCard for an existing character with incremented mention count. */
export function buildUpdatedCard(
  existing: CharacterCard,
  turnId: string
): CharacterCard {
  const ext = (existing.extensions[PLUGIN_ID] ?? {}) as TrackerExtension;
  const updatedExt: TrackerExtension = {
    ...ext,
    lastSeenTurn: turnId,
    mentionCount: (ext.mentionCount ?? 0) + 1,
  };
  return {
    ...existing,
    extensions: {
      ...existing.extensions,
      [PLUGIN_ID]: updatedExt,
    },
    version: existing.version + 1,
  };
}

/** Build a new CharacterCard for a newly discovered character. */
export function buildNewCard(
  name: string,
  narrative: string,
  isZh: boolean,
  turnId: string,
  runId: string,
  worldId: string
): CharacterCard {
  const charType: CharacterType =
    inferRole(name, narrative, isZh) === "protagonist" ? "companion" : "npc";
  const trackerExt: TrackerExtension = {
    firstSeenTurn: turnId,
    lastSeenTurn: turnId,
    mentionCount: 1,
  };
  return {
    id: "",
    worldId,
    runId,
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
}

/** Build co-occurrence relationship proposals between characters mentioned in the same turn. */
export function buildRelationshipProposals(
  names: readonly string[],
  turnId: string
): Array<{ kind: string; payload: RelationshipUpsertPayload }> {
  const proposals: Array<{ kind: string; payload: RelationshipUpsertPayload }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      proposals.push({
        kind: "record.upsert",
        payload: {
          key: `rel:${names[i]}:${names[j]}`,
          recordType: "character_relationship",
          value: {
            fromCharacterName: names[i]!,
            toCharacterName: names[j]!,
            type: "acquaintance",
            lastInteractionTurnId: turnId,
          },
        },
      });
    }
  }
  return proposals;
}
