import type { RuntimeHandlerContext, RuntimeHandlerResult } from "@covel/plugin-runtime";
import type { CharacterCard, RuntimeContextView } from "@covel/shared";
import {
  PLUGIN_ID,
  extractChineseNames,
  extractEnglishNames,
  buildUpdatedCard,
  buildNewCard,
  buildRelationshipProposals,
} from "./logic.js";

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
export async function charTrackerHandler(
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
      const updatedCard = buildUpdatedCard(existing, turnId);
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
      const card = buildNewCard(
        name,
        narrative,
        isZh,
        turnId,
        context.run.runId,
        context.run.worldId ?? ""
      );
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
    proposals.push(...buildRelationshipProposals(extracted, turnId));
  }

  proposals.push({
    kind: "state.patch",
    payload: {
      characters: updatedChars,
    },
  });

  return { proposals };
}
