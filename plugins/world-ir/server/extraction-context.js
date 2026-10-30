import { modelFacingJson } from "@covel/plugin-handlers-utils";
import { characterHandles } from "../tools/character-handles.js";
import { vocabularyEntries } from "../tools/vocabulary.js";

/**
 * Fact extraction consumes a typed current-turn input. Full history and memory
 * duplicate prior facts, expand latency, and encourage extracting old changes.
 * Keep known names (characters and the tracked vocabulary) as disambiguation
 * data, never as evidence of a new event. Characters carry short word handles
 * in place of their ids (see `character-handles.js`).
 *
 * NOTE: This Hook is retained by design (08 §4.7). It prunes history/memory
 * to prevent re-extracting old facts, which is a legitimate context trimming
 * use case allowed by the extension architecture (02 §2 "裁剪已有上下文").
 */
export default async function extractionContext(ctx, payload) {
  if (ctx.runtimeId !== "world-ir") return { action: "continue" };
  const narrative = payload.inputSlots?.narrative;
  const turn = payload.inputSlots?.turn;
  if (
    narrative?.cardinality !== "one" ||
    !Array.isArray(narrative.value) ||
    turn?.cardinality !== "one" ||
    typeof turn.value?.playerMessage !== "string" ||
    !payload.promptTemplate
  ) {
    return { action: "continue" };
  }
  const handles = characterHandles(payload.characters ?? []);
  const player = [...handles].find(
    ([, character]) => character.id === payload.currentCharacterId,
  )?.[0];
  const characters = [...handles].map(([handle, { name, type }]) => ({
    id: handle,
    name,
    type,
  }));
  const vocabulary = vocabularyEntries(payload.inputSlots?.vocabulary);
  return {
    action: "continue",
    replace: {
      systemPrompt: payload.promptTemplate,
      messages: [
        {
          role: "user",
          // The roster and the vocabulary change on few turns and the
          // narrative on every turn, so they come first: a provider's prompt
          // cache serves a request only as far as it repeats the last one.
          content: JSON.stringify(
            modelFacingJson({
              characters,
              ...(vocabulary.length ? { vocabulary } : {}),
              // Keep attribution from the contract, without source bookkeeping.
              playerInput: {
                ...(player ? { character: player } : {}),
                text: turn.value.playerMessage,
              },
              narrative: {
                cardinality: narrative.cardinality,
                value: narrative.value,
              },
            }),
          ),
        },
      ],
    },
  };
}
