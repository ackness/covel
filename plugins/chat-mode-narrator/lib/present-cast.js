import {
  mentionedCharacterIds,
  pickLocaleText,
  resolveCharacter,
  seatCharacterIds,
  storyOutputSchema,
  STORY_LIMITS,
} from "@covel/plugin-handlers-utils";

export function previousStory(value) {
  const parsed = storyOutputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { segments, cues } = parsed.data;
  return {
    segments: segments.map(({ kind, speaker, text }) => ({
      kind,
      ...(speaker ? { speaker } : {}),
      text,
    })),
    ...(cues
      ? {
          cues: {
            ...(cues.present ? { present: cues.present } : {}),
            ...(cues.scene ? { scene: cues.scene } : {}),
          },
        }
      : {}),
  };
}

export function presentCast(ctx, previous) {
  const characters = ctx.world?.characters ?? [];
  const seats = ctx.world?.seats ?? [];
  const bound = new Set(
    seats
      .filter((seat) => seat.controller === "human")
      .flatMap((seat) => seatCharacterIds(seat, characters, seats)),
  );
  const stage = ctx.inputs?.["active-cast"]?.value;
  const stageSpeakers = Array.isArray(stage?.speakers)
    ? stage.speakers
    : undefined;
  const ids = new Set();
  const addName = (name, id) => {
    if (typeof name !== "string" || !name || name.length > STORY_LIMITS.speaker)
      return;
    const found = resolveCharacter(characters, name);
    if (
      found.status === "found" &&
      found.matchedBy !== "id" &&
      (id === undefined || id === found.character.id)
    )
      ids.add(found.character.id);
  };
  if (stageSpeakers) {
    for (const speaker of stageSpeakers) addName(speaker?.name, speaker?.id);
  } else {
    const present = previous?.cues?.present;
    if (present !== undefined) for (const name of present) addName(name);
    if (present === undefined || present.length)
      for (const segment of previous?.segments ?? []) addName(segment.speaker);
    for (const action of ctx.playerActions) {
      for (const id of mentionedCharacterIds(action.text, characters)) {
        const character = characters.find((item) => item.id === id);
        if (character) addName(character.name);
      }
      if (
        action.kind.endsWith("/choose-actors") &&
        typeof action.fields?.actors === "string"
      )
        for (const name of action.fields.actors
          .split(/\r?\n/u)
          .map((line) => line.trim()))
          addName(name);
    }
  }
  return [...ids]
    .flatMap((id) => {
      const character = characters.find((item) => item.id === id);
      return character && !bound.has(id)
        ? [{ characterId: id, name: character.name }]
        : [];
    })
    .slice(0, STORY_LIMITS.present);
}

export function observableBrief(actions, locale) {
  // Historical observations come from each actor's witnessed history.
  const observed = actions
    .filter((action) => ["say", "act", "narrate"].includes(action.kind))
    .map((action) => action.text ?? "");
  return (
    observed.join("\n").slice(-6_000) ||
    pickLocaleText(
      locale,
      "根据当前可观察场景简短回应，不编造以前的对话。",
      "Respond briefly to the current observable scene. Do not invent earlier conversations.",
    )
  );
}
