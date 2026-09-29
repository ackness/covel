import { validateWorldModel } from "@covel/shared";
import type { StoreTransaction } from "@covel/store";
import { characterRecordFromValue } from "../../../world-data/character-effects.js";

/** Portable stored worlds carry the same canonical records as file-backed character sources. */
export async function importWorldEmbeddedCharacters(
  store: StoreTransaction,
  sessionId: string,
  worldId: string | null | undefined,
  now: string,
): Promise<void> {
  if (!worldId) return;
  const world = await store.getWorld(worldId);
  const values = world?.metadata?.embeddedCharacters;
  if (values === undefined) return;
  if (!Array.isArray(values))
    throw new Error("embeddedCharacters must be an array");
  const records = values.map((value) => {
    const record = characterRecordFromValue(sessionId, value, now);
    if (!record) throw new Error("Invalid embedded character record");
    return record;
  });
  validateWorldModel({
    characters: records,
    characterSchema: await store.getCharacterSchema(sessionId),
  });
  for (const record of records) await store.upsertCharacter(record);
}
