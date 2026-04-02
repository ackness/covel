import type { CharacterCard, CharacterType, DynamicFieldSchema } from "@covel/shared";

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
  turnId: string,
  fieldUpdates?: Record<string, unknown>,
): CharacterCard {
  const ext = (existing.extensions[PLUGIN_ID] ?? {}) as TrackerExtension;
  const updatedExt: TrackerExtension = {
    ...ext,
    lastSeenTurn: turnId,
    mentionCount: (ext.mentionCount ?? 0) + 1,
  };
  return {
    ...existing,
    fields: fieldUpdates
      ? { ...existing.fields, ...fieldUpdates }
      : existing.fields,
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
  worldId: string,
  fields?: Record<string, unknown>,
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
    fields: fields ?? {},
    extensions: {
      [PLUGIN_ID]: trackerExt,
    },
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

// ── Schema-aware LLM Extraction ──────────────────────────────────

/**
 * Build a prompt for LLM to extract character field updates from narrative.
 */
export function buildFieldExtractionPrompt(
  narrative: string,
  schema: DynamicFieldSchema,
  existingCharacters: readonly CharacterCard[],
  isZh: boolean,
): string {
  const fieldDescriptions = schema.fields
    .map((f) => {
      let desc = `"${f.key}" (${f.label}, type: ${f.type})`;
      if (f.options) desc += ` options: [${f.options.join(", ")}]`;
      if (f.min !== undefined || f.max !== undefined) desc += ` range: ${f.min ?? ""}..${f.max ?? ""}`;
      return desc;
    })
    .join("\n  ");

  const existingInfo = existingCharacters.length > 0
    ? existingCharacters.map((c) => `- ${c.name}: ${JSON.stringify(c.fields)}`).join("\n")
    : (isZh ? "（暂无已知角色）" : "(no known characters yet)");

  if (isZh) {
    return `分析以下叙事文本，提取角色信息变化。

## 角色字段 Schema
  ${fieldDescriptions}

## 已有角色及其当前字段值
${existingInfo}

## 叙事文本
${narrative}

## 要求
1. 识别叙事中提到的所有角色（包括新角色和已知角色）
2. 根据叙事内容，推断字段值的变化（如 HP 减少、位置变化、状态改变等）
3. 只输出有变化或新发现的字段，不要输出未改变的字段
4. 对于新角色，尽量根据叙事推断初始字段值

返回严格的 JSON 格式（不要包含其他文字）：
{"characters":{"角色名":{"fieldKey":"newValue"}}}`;
  }

  return `Analyze the narrative below and extract character field changes.

## Character Field Schema
  ${fieldDescriptions}

## Known Characters and Current Fields
${existingInfo}

## Narrative
${narrative}

## Requirements
1. Identify all characters mentioned (both new and known)
2. Infer field value changes from narrative (HP decrease, location change, status change, etc.)
3. Only output changed or newly discovered fields, skip unchanged fields
4. For new characters, infer initial field values from narrative

Return strict JSON only (no other text):
{"characters":{"CharacterName":{"fieldKey":"newValue"}}}`;
}

/**
 * Parse LLM response for field extraction. Returns a map of character name → field updates.
 * Gracefully returns empty map on parse failure.
 */
export function parseFieldExtractionResponse(
  response: string,
): Record<string, Record<string, unknown>> {
  try {
    // Strip markdown code fences if present
    const cleaned = response.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned) as { characters?: Record<string, Record<string, unknown>> };
    if (parsed.characters && typeof parsed.characters === "object") {
      return parsed.characters;
    }
  } catch {
    // LLM returned unparseable response — fall back silently
  }
  return {};
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
