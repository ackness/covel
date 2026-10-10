import {
  makeProposal,
  resolveCharacter,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

const DIRECTION_NS = "direction";
const DIRECTION_KEY = "current";
const MAX_ACTORS = 4;
const POSITIONS = new Set([
  "left",
  "center-left",
  "center",
  "center-right",
  "right",
]);

/** @param {import('@covel/plugin-handlers-utils').PluginFunctionContext} ctx */
export default async function handler(ctx) {
  const evt = ctx.triggerEvent;
  const cues = Array.isArray(evt?.data?.cues) ? evt.data.cues : [];
  const paragraphSpeakers = evt?.data?.dialogue?.paragraphSpeakers;
  const hasDialogue =
    Array.isArray(paragraphSpeakers) &&
    paragraphSpeakers.length > 0 &&
    paragraphSpeakers.length <= 80;
  if (
    !evt ||
    evt.topic !== "stage.direction" ||
    (!cues.length && !hasDialogue)
  ) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no usable stage.direction cues" },
    };
  }

  const previous =
    (await ctx.pluginData?.get(DIRECTION_NS, DIRECTION_KEY)) ?? null;
  const characters = listCharacters(ctx.world);
  const hadDirectionState = previous !== null && previous !== undefined;
  let actors = normalizeActors(previous?.actors);
  const diagnostics = [];
  const dialogue = hasDialogue
    ? {
        schemaVersion: 1,
        turnId: ctx.turnId,
        paragraphSpeakers: paragraphSpeakers.map((characterId) => {
          if (characterId === null) return null;
          const character = characters.find((row) => row.id === characterId);
          if (!character) {
            diagnostics.push(
              `unresolved dialogue speaker: ${String(characterId)}`,
            );
            return null;
          }
          return { characterId: character.id, displayName: character.name };
        }),
      }
    : undefined;
  const proposals = dialogue
    ? [
        makeProposal(ctx, new Date().toISOString(), "plugin.data", {
          namespace: "dialogue",
          // One row, like the stage's other state: the record names its turn.
          key: "current",
          value: dialogue,
        }),
      ]
    : [];
  let changed = false;

  for (const cue of cues) {
    if (!cue || typeof cue !== "object") continue;
    if (cue.type === "stage.clear") {
      changed ||= actors.length > 0 || !hadDirectionState;
      actors = [];
      continue;
    }

    const matched = resolveActor(
      cue.character,
      actors,
      characters.filter((character) => character.type !== "player"),
    );
    if (!matched) {
      diagnostics.push(`unresolved character: ${String(cue.character ?? "")}`);
      continue;
    }

    if (cue.type === "actor.leave") {
      const next = actors.filter((actor) => actor.characterId !== matched.id);
      changed ||= next.length !== actors.length;
      actors = next;
      continue;
    }

    if (cue.type === "actor.focus") {
      if (!actors.some((actor) => actor.characterId === matched.id)) {
        diagnostics.push(`focus target is not on stage: ${matched.name}`);
        continue;
      }
      actors = actors.map((actor) => ({
        ...actor,
        active: actor.characterId === matched.id,
      }));
      changed = true;
      continue;
    }

    if (cue.type !== "actor.enter" && cue.type !== "actor.update") continue;
    const index = actors.findIndex((actor) => actor.characterId === matched.id);
    if (index < 0 && actors.length >= MAX_ACTORS) {
      diagnostics.push(
        `stage actor limit (${MAX_ACTORS}) reached: ${matched.name}`,
      );
      continue;
    }

    const current = index >= 0 ? actors[index] : null;
    const visual = patchVisual(current?.visual, cue);
    const position = POSITIONS.has(cue.position)
      ? cue.position
      : current?.position;
    const nextActor = {
      characterId: matched.id,
      displayName: matched.name,
      active:
        typeof cue.focus === "boolean"
          ? cue.focus
          : (current?.active ?? actors.length === 0),
      ...(position ? { position } : {}),
      ...(visual ? { visual } : {}),
      ...(typeof cue.transition === "string"
        ? { transition: cue.transition }
        : current?.transition
          ? { transition: current.transition }
          : {}),
    };

    if (nextActor.active) {
      actors = actors.map((actor) => ({ ...actor, active: false }));
    }
    if (nextActor.position) {
      actors = actors.map((actor) =>
        actor.characterId !== matched.id &&
        actor.position === nextActor.position
          ? withoutPosition(actor)
          : actor,
      );
    }
    if (index >= 0) actors[index] = nextActor;
    else actors.push(nextActor);
    changed = true;
  }

  if (!changed) {
    return withPendingProposals(
      {
        outcome: "success",
        value: {
          skipped: !dialogue,
          ...(dialogue ? { dialogue } : {}),
          diagnostics,
        },
      },
      proposals,
    );
  }
  if (actors.length > 0 && !actors.some((actor) => actor.active)) {
    actors = actors.map((actor, index) => ({ ...actor, active: index === 0 }));
  }

  const direction = {
    schemaVersion: 1,
    actors,
    turnId: ctx.turnId,
    updatedAt: new Date().toISOString(),
  };
  const proposal = makeProposal(ctx, new Date().toISOString(), "plugin.data", {
    namespace: DIRECTION_NS,
    key: DIRECTION_KEY,
    value: direction,
  });
  return withPendingProposals(
    {
      outcome: "success",
      value: { direction, ...(dialogue ? { dialogue } : {}), diagnostics },
    },
    [proposal, ...proposals],
  );
}

function patchVisual(current, cue) {
  const next = { ...current };
  const hasVariantId =
    typeof cue.variantId === "string" && cue.variantId.length > 0;
  const hasSemanticPatch = [cue.outfit, cue.expression, cue.pose].some(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (!hasVariantId && hasSemanticPatch) delete next.variantId;
  for (const key of ["variantId", "outfit", "expression", "pose"]) {
    if (typeof cue[key] === "string" && cue[key].length > 0) {
      next[key] = cue[key];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function withoutPosition(actor) {
  const { position: _position, ...rest } = actor;
  return rest;
}

function normalizeActors(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (actor) =>
        actor &&
        typeof actor === "object" &&
        typeof actor.characterId === "string" &&
        typeof actor.displayName === "string",
    )
    .slice(0, MAX_ACTORS)
    .map((actor) => ({ ...actor, active: actor.active === true }));
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * Who a cue means: a session character by id, name or alias, or an actor
 * already on stage. A cue places a picture and writes no game state, so one
 * character whose name contains the cue's also counts.
 */
function resolveActor(value, actors, characters) {
  const token = normalizeToken(value);
  if (!token) return null;
  // One entry per id, the session character first: it has the aliases.
  const available = [
    ...new Map(
      [
        ...actors.map((actor) => ({
          id: actor.characterId,
          name: actor.displayName,
        })),
        ...characters,
      ].map((candidate) => [candidate.id, candidate]),
    ).values(),
  ];
  // A world's character id ends with the cue's short form (`npc-mio`).
  const byId = available.find((candidate) => {
    const id = normalizeToken(candidate.id);
    return id === token || id.endsWith(`-${token}`);
  });
  if (byId) return byId;
  const resolution = resolveCharacter(available, String(value), {
    partial: true,
  });
  return resolution.status === "found" ? resolution.character : null;
}

function listCharacters(world) {
  const rows = world?.characters;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.id === "string" &&
        typeof row.name === "string",
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      ...(Array.isArray(row.aliases) ? { aliases: row.aliases } : {}),
      type: row.type,
    }));
}
