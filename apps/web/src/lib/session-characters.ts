import type { SeatCharacter } from "@covel/shared";

/** A character of the session World Model as the interface reads it. */
export interface SessionCharacter extends SeatCharacter {
  readonly name: string;
}

/**
 * The characters in a session's game state, in World Model order. Entries
 * without an ID and a type are skipped; a missing name is empty.
 */
export function sessionCharacters(
  gameState: Readonly<Record<string, unknown>>,
): SessionCharacter[] {
  const raw = Array.isArray(gameState.characters) ? gameState.characters : [];
  return raw.flatMap((entry): SessionCharacter[] => {
    if (!entry || typeof entry !== "object") return [];
    const character = entry as Record<string, unknown>;
    return typeof character.id === "string" &&
      typeof character.type === "string"
      ? [
          {
            id: character.id,
            type: character.type,
            name: typeof character.name === "string" ? character.name : "",
          },
        ]
      : [];
  });
}
