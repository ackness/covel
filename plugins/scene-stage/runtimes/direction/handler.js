import { makeProposal } from "@covel/plugin-handlers-utils";
import { withPendingProposals } from "@covel/tools";

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

/** @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx */
export default async function handler(ctx) {
  const evt = ctx.triggerEvent;
  const cues = Array.isArray(evt?.data?.cues) ? evt.data.cues : [];
  if (!evt || evt.topic !== "stage.direction" || cues.length === 0) {
    return {
      outcome: "success",
      value: { skipped: true, reason: "no usable stage.direction cues" },
    };
  }

  const [previous, characters] = await Promise.all([
    ctx.pluginData?.get(DIRECTION_NS, DIRECTION_KEY) ?? null,
    listCharacters(ctx.store, ctx.sessionId),
  ]);
  const hadDirectionState = previous !== null && previous !== undefined;
  let actors = normalizeActors(previous?.actors);
  const diagnostics = [];
  let changed = false;

  for (const cue of cues) {
    if (!cue || typeof cue !== "object") continue;
    if (cue.type === "stage.clear") {
      changed ||= actors.length > 0 || !hadDirectionState;
      actors = [];
      continue;
    }

    const matched = resolveActor(cue.character, actors, characters);
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
    return {
      outcome: "success",
      value: { skipped: true, diagnostics },
    };
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
      value: { direction, diagnostics },
    },
    [proposal],
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

function resolveActor(value, actors, characters) {
  const token = normalizeToken(value);
  if (!token) return null;
  const available = [
    ...actors.map((actor) => ({
      id: actor.characterId,
      name: actor.displayName,
    })),
    ...characters,
  ];
  const exact = available.find((candidate) => {
    const id = normalizeToken(candidate.id);
    const name = normalizeToken(candidate.name);
    return id === token || name === token || id.endsWith(`-${token}`);
  });
  if (exact) return exact;

  const partial = available.filter((candidate) => {
    const name = normalizeToken(candidate.name);
    return name.includes(token) || token.includes(name);
  });
  const unique = new Map(partial.map((candidate) => [candidate.id, candidate]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

async function listCharacters(store, sessionId) {
  if (!store || typeof store.listCharacters !== "function") return [];
  const rows = await store.listCharacters(sessionId);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        row &&
        typeof row === "object" &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        row.type !== "player",
    )
    .map((row) => ({ id: row.id, name: row.name }));
}
