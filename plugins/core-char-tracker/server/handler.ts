import type { RuntimeHandlerContext, RuntimeHandlerResult } from "@covel/plugin-runtime";
import type { CharacterCard, RuntimeContextView, DynamicFieldSchema } from "@covel/shared";
import {
  PLUGIN_ID,
  extractChineseNames,
  extractEnglishNames,
  buildUpdatedCard,
  buildNewCard,
  buildRelationshipProposals,
  buildFieldExtractionPrompt,
  parseFieldExtractionResponse,
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

  // Read schema from state (set by core-npc-init)
  const stateObj = context.state as Record<string, unknown> | undefined;
  let schema = stateObj?.characterFieldSchema as DynamicFieldSchema | undefined;

  // Fallback: read schema from records if not in session state
  if (!schema && ctx.data) {
    try {
      const rec = ctx.data.records.get("schema:character-fields");
      if (rec) {
        schema = (rec as Record<string, unknown>).fields as DynamicFieldSchema | undefined;
      }
    } catch {
      // Records unavailable — continue without schema
    }
  }

  // Extract character names via regex (always needed for name discovery)
  const extracted = isZh
    ? extractChineseNames(narrative)
    : extractEnglishNames(narrative);

  // Schema-aware: use LLM to extract field updates
  let fieldUpdatesByName: Record<string, Record<string, unknown>> = {};
  if (schema && ctx.generateText) {
    try {
      const prompt = await buildFieldExtractionPrompt(narrative, schema, existingCards, isZh);
      const response = await ctx.generateText(prompt);
      if (response) {
        fieldUpdatesByName = parseFieldExtractionResponse(response);
      }
    } catch {
      // LLM extraction failed — continue with regex-only path
    }
  }

  // Merge LLM-discovered names with regex-discovered names
  const allNames = new Set(extracted);
  for (const name of Object.keys(fieldUpdatesByName)) {
    allNames.add(name);
  }

  if (allNames.size === 0) return { proposals: [] };

  const proposals: Array<{ kind: string; payload: unknown }> = [];
  const updatedChars: Record<string, CharacterCard> = {};
  for (const card of existingCards) {
    updatedChars[card.name] = card;
  }

  for (const name of allNames) {
    const existing = knownByName.get(name);
    const fieldUpdates = fieldUpdatesByName[name];

    if (existing) {
      const updatedCard = buildUpdatedCard(existing, turnId, fieldUpdates);
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
        context.run.worldId ?? "",
        fieldUpdates,
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
  const nameArray = Array.from(allNames);
  if (nameArray.length > 1) {
    proposals.push(...buildRelationshipProposals(nameArray, turnId));
  }

  proposals.push({
    kind: "state.patch",
    payload: {
      characters: updatedChars,
    },
  });

  return { proposals };
}
