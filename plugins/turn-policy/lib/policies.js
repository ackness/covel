import {
  compareText,
  mentionedCharacterIds,
  resolveCharacter,
  validateTurnPolicyOutput,
} from "@covel/plugin-handlers-utils";
import { director } from "./director.js";
import { manualSelection, nameLines, resolveName } from "./manual-selection.js";

const empty = () => ({
  actors: [],
  order: "sequential",
  narrator: "after",
  yieldHint: "user",
});

function continuation(actions, seats) {
  return actions.some(
    (action) =>
      (action.kind === "advance" && action.source === "system") ||
      (action.source === "player" &&
        seats.some(
          (seat) =>
            seat.id === action.seatId &&
            seat.controller === "human" &&
            ((seat.role === "host" &&
              ["direct", "advance"].includes(action.kind)) ||
              (seat.role === "spectator" && action.kind === "advance")),
        )),
  );
}

export async function chooseActors(input, ctx, pluginId) {
  ctx.signal.throwIfAborted();
  const cap = Math.min(input.limits.maxActors, input.limits.maxSubagentCalls);
  if (!cap || !input.present.length) return empty();
  const settings = ctx.getOwnSettings();
  const strategy = settings.strategy ?? "mention";
  const characters = ctx.world.characters;
  // Resolve against the whole world so an ambiguous or overlapping name is never guessed.
  const present = input.present.filter((actor, index, all) => {
    const resolved = resolveCharacter(characters, actor.name);
    return (
      resolved.status === "found" &&
      resolved.matchedBy !== "id" &&
      resolved.character.id === actor.characterId &&
      all.findIndex((other) => other.characterId === actor.characterId) ===
        index
    );
  });
  if (!present.length) return empty();
  let actors;
  let order = "sequential";
  let yieldHint = "user";
  if (strategy === "director" && ctx.gateway)
    return director({ ...input, present }, ctx);
  if (strategy === "manual") {
    actors = manualSelection(input.actions, characters, present, pluginId);
  } else if (strategy === "list") {
    const names = nameLines(settings.actorOrder ?? "");
    const listed = names.map((name) => resolveName(characters, name).id);
    const indices = new Map(
      [...new Set(listed)].map((id, index) => [id, index]),
    );
    const sorted = names.length
      ? [...present].sort((a, b) => {
          const left = indices.get(a.characterId),
            right = indices.get(b.characterId);
          if (left !== undefined || right !== undefined)
            return (left ?? Infinity) - (right ?? Infinity);
          return compareText(a.name, b.name);
        })
      : present;
    actors = sorted.map(({ characterId }) => ({ characterId }));
    yieldHint = continuation(input.actions, ctx.world.seats)
      ? "continue"
      : "user";
  } else if (strategy === "random") {
    const spoke = new Set(
      input.actions
        .filter((action) => action.source === "player")
        .map((action) => action.actorId),
    );
    const candidates = present.filter((actor) => !spoke.has(actor.characterId));
    actors = [];
    while (candidates.length && actors.length < cap) {
      const [actor] = candidates.splice(
        ctx.random.int(0, candidates.length),
        1,
      );
      actors.push({ characterId: actor.characterId });
    }
    order = "parallel";
    yieldHint = continuation(input.actions, ctx.world.seats)
      ? "continue"
      : "user";
  } else {
    const last = input.recentSegments.at(-1);
    const text = [
      ...input.actions.map((action) => action.text ?? ""),
      last?.speaker ?? "",
      last?.text ?? "",
    ].join("\n");
    const mentions = mentionedCharacterIds(text, characters);
    actors = present
      .filter((actor) => mentions.has(actor.characterId))
      .map(({ characterId }) => ({ characterId }));
    // A function host without a gateway can still apply the deterministic mention strategy.
    if (strategy === "director")
      actors = actors.map((actor) => ({
        ...actor,
        reason: "Director unavailable; mention strategy used.",
      }));
  }
  const selected = actors.slice(0, cap);
  ctx.signal.throwIfAborted();
  return validateTurnPolicyOutput(input, {
    actors: selected,
    order,
    narrator: "after",
    yieldHint: selected.length ? yieldHint : "user",
  });
}
