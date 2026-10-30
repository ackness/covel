import {
  currentCharacterOf,
  primarySeat,
  resolveCharacter,
} from "@covel/plugin-handlers-utils";
import { MAX_SPRITE_SLOTS } from "./stage-view.js";

const POSITIONS = ["left", "center-left", "center", "center-right", "right"];

/** Resolve presence exactly; continuing actors keep their position and visual. */
export function castFromPresence(ctx, previous, present, segments) {
  const characters = ctx.world?.characters ?? [];
  const seats = ctx.world?.seats ?? [];
  const viewpoint = currentCharacterOf(primarySeat(seats), characters, seats);
  const resolved = new Map();
  const diagnostics = [];
  for (const name of present) {
    if (typeof name !== "string") continue;
    const match = resolveCharacter(characters, name);
    if (match.status !== "found") {
      diagnostics.push(`unresolved character: ${name}`);
      continue;
    }
    if (match.character.id !== viewpoint?.id)
      resolved.set(match.character.id, match.character);
  }
  const selected = [...resolved.values()].slice(0, MAX_SPRITE_SLOTS);
  const previousActors = Array.isArray(previous?.actors) ? previous.actors : [];
  const continuing = new Map(
    previousActors.map((actor) => [actor.characterId, actor]),
  );
  const occupied = new Set(
    selected.map((character) => continuing.get(character.id)?.position),
  );
  const actors = selected.map((character) => {
    const current = continuing.get(character.id);
    if (current) return { ...current, displayName: character.name };
    const position = POSITIONS.find((slot) => !occupied.has(slot));
    occupied.add(position);
    return {
      characterId: character.id,
      displayName: character.name,
      active: false,
      ...(position ? { position } : {}),
      transition: "fade",
    };
  });

  let lastSpeaker;
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (
      (segment.kind !== "dialogue" && segment.kind !== "action") ||
      typeof segment.speaker !== "string"
    )
      continue;
    const match = resolveCharacter(characters, segment.speaker);
    if (
      match.status === "found" &&
      actors.some((actor) => actor.characterId === match.character.id)
    )
      lastSpeaker = match.character.id;
  }
  const focus =
    actors.find((actor) => actor.characterId === lastSpeaker) ??
    actors.find((actor) => actor.active) ??
    actors[0];
  return {
    direction: {
      schemaVersion: 1,
      actors: actors.map((actor) => ({ ...actor, active: actor === focus })),
      turnId: ctx.turnId,
      updatedAt: new Date().toISOString(),
    },
    diagnostics,
  };
}
