import type {
  CharacterVisualRequest,
  PresenceRecord,
} from "@/lib/character-visuals.js";

export interface StageCurrentRecord {
  readonly sceneId?: string;
  readonly name?: string;
  readonly variant?: "day" | "night";
  readonly source?: "world" | "session" | "pending" | "none";
  readonly sourceLabel?: unknown;
  readonly resolved?: unknown;
  readonly day?: unknown;
  readonly night?: unknown;
  readonly turnId?: string;
}

export interface StageSceneRegistry {
  readonly scenes?: readonly unknown[];
}

export type SpritePosition =
  "left" | "center-left" | "center" | "center-right" | "right";

export type StageTransition =
  "none" | "fade" | "slide-left" | "slide-right" | "dissolve";

export interface StageSpeaker {
  readonly id: string;
  readonly name: string;
  readonly visual?: CharacterVisualRequest;
  readonly position?: SpritePosition;
  readonly transition?: StageTransition;
  /** Speculative preview marker. Durable direction state removes departed
   * actors; the preview keeps them for one CSS exit animation. */
  readonly exiting?: boolean;
}

export interface StageDirectionActor {
  readonly characterId?: unknown;
  readonly displayName?: unknown;
  readonly active?: unknown;
  readonly visual?: CharacterVisualRequest;
  readonly position?: unknown;
  readonly transition?: unknown;
}

/** Shape written by the `stage-direction` capability provider to
 * `direction/current`. The record itself is authoritative once present:
 * `actors: []` means the director intentionally cleared the stage. */
export interface StageDirectionRecord {
  readonly schemaVersion?: unknown;
  readonly actors?: readonly StageDirectionActor[];
  readonly turnId?: unknown;
  readonly updatedAt?: unknown;
}

export const MAX_SPRITE_SLOTS = 4;

function normalizeSceneLocation(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Resolve a validated scene.set event against already-imported world art for
 * immediate display. Unknown locations enter a non-destructive pending state;
 * the durable resolver remains responsible for generation gates/session art. */
export function applySceneSetPreview(
  current: StageCurrentRecord | null | undefined,
  registry: StageSceneRegistry | null | undefined,
  data: Readonly<Record<string, unknown>>,
  turnId?: string,
): StageCurrentRecord | null | undefined {
  const location =
    typeof data.location === "string" ? data.location.trim() : "";
  if (!location) return current;
  const token = normalizeSceneLocation(location);
  const variant = data.timeOfDay === "night" ? "night" : "day";
  const scenes = Array.isArray(registry?.scenes)
    ? registry.scenes.filter(
        (scene): scene is Readonly<Record<string, unknown>> =>
          Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
      )
    : [];
  const exact = scenes.find(
    (scene) =>
      normalizeSceneLocation(scene.name) === token ||
      normalizeSceneLocation(scene.locationRef) === token,
  );
  const matched =
    exact ??
    scenes.find((scene) =>
      [scene.name, scene.locationRef]
        .map(normalizeSceneLocation)
        .filter(Boolean)
        .some((key) => token.includes(key) || key.includes(token)),
    );
  if (!matched) {
    return {
      ...current,
      name: location,
      variant,
      source: "pending",
      sourceLabel: { zh: "场景解析中…", en: "Resolving…" }, // i18n-allow -- serialized I18nText data
      resolved: undefined,
      ...(turnId ? { turnId } : {}),
    };
  }

  const day = matched.day;
  const night = matched.night;
  return {
    sceneId:
      typeof matched.sceneId === "string" ? matched.sceneId : current?.sceneId,
    name: typeof matched.name === "string" ? matched.name : location,
    variant,
    source: "world",
    sourceLabel: { zh: "世界背景", en: "World art" }, // i18n-allow -- serialized I18nText data
    day,
    night,
    resolved: variant === "night" ? (night ?? day) : day,
    ...(turnId ? { turnId } : {}),
  };
}

function isSpritePosition(value: unknown): value is SpritePosition {
  return (
    value === "left" ||
    value === "center-left" ||
    value === "center" ||
    value === "center-right" ||
    value === "right"
  );
}

function isStageTransition(value: unknown): value is StageTransition {
  return (
    value === "none" ||
    value === "fade" ||
    value === "slide-left" ||
    value === "slide-right" ||
    value === "dissolve"
  );
}

/** Prefer persistent stage-direction actors when that capability has produced
 * state; otherwise preserve the legacy scene-cast behavior. */
export function resolveStageSpeakers(
  direction: StageDirectionRecord | null | undefined,
  fallback: readonly StageSpeaker[],
): StageSpeaker[] {
  if (!direction) return [...fallback];

  const actors = Array.isArray(direction.actors) ? direction.actors : [];
  const normalized = actors
    .filter(
      (
        actor,
      ): actor is StageDirectionActor & {
        readonly characterId: string;
        readonly displayName: string;
      } =>
        typeof actor?.characterId === "string" &&
        actor.characterId.length > 0 &&
        typeof actor.displayName === "string" &&
        actor.displayName.length > 0,
    )
    .slice(0, MAX_SPRITE_SLOTS);
  const focusedIndex = normalized.findIndex((actor) => actor.active === true);
  const ordered =
    focusedIndex > 0
      ? [
          normalized[focusedIndex],
          ...normalized.slice(0, focusedIndex),
          ...normalized.slice(focusedIndex + 1),
        ]
      : normalized;
  const occupied = new Set<SpritePosition>();

  return ordered.map((actor) => {
    const position = isSpritePosition(actor.position)
      ? actor.position
      : undefined;
    const uniquePosition =
      position && !occupied.has(position) ? position : undefined;
    if (uniquePosition) occupied.add(uniquePosition);
    return {
      id: actor.characterId,
      name: actor.displayName,
      ...(actor.visual ? { visual: actor.visual } : {}),
      ...(uniquePosition ? { position: uniquePosition } : {}),
      ...(isStageTransition(actor.transition)
        ? { transition: actor.transition }
        : {}),
    };
  });
}

function normalizeActorToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function previewActorCandidates(
  speakers: readonly StageSpeaker[],
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
): StageSpeaker[] {
  const candidates = [...speakers];
  for (const presence of Object.values(presenceMap)) {
    const id = presence?.characterId;
    const name = presence?.displayName;
    if (typeof id !== "string" || typeof name !== "string") continue;
    const alreadyKnown = candidates.some(
      (candidate) =>
        candidate.id === id ||
        candidate.id.endsWith(`-${id}`) ||
        normalizeActorToken(candidate.name) === normalizeActorToken(name),
    );
    if (!alreadyKnown) candidates.push({ id, name });
  }
  return candidates;
}

function resolvePreviewActor(
  value: unknown,
  speakers: readonly StageSpeaker[],
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
): StageSpeaker | undefined {
  const token = normalizeActorToken(value);
  if (!token) return undefined;
  const candidates = previewActorCandidates(speakers, presenceMap);
  const exact = candidates.find((candidate) => {
    const id = normalizeActorToken(candidate.id);
    const name = normalizeActorToken(candidate.name);
    return id === token || name === token || id.endsWith(`-${token}`);
  });
  if (exact) return exact;
  const partial = candidates.filter((candidate) => {
    const name = normalizeActorToken(candidate.name);
    return name.includes(token) || token.includes(name);
  });
  return partial.length === 1 ? partial[0] : undefined;
}

function cueVisual(
  current: CharacterVisualRequest | undefined,
  cue: Readonly<Record<string, unknown>>,
): CharacterVisualRequest | undefined {
  const next: Record<string, string> = { ...current };
  const hasVariantId =
    typeof cue.variantId === "string" && cue.variantId.length > 0;
  const hasSemanticPatch = [cue.outfit, cue.expression, cue.pose].some(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (!hasVariantId && hasSemanticPatch) delete next.variantId;
  for (const key of ["variantId", "outfit", "expression", "pose"] as const) {
    const value = cue[key];
    if (typeof value === "string" && value.length > 0) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Apply a validated-but-not-yet-committed stage.direction event for immediate
 * presentation. Unresolved actors are skipped; durable state wins at commit. */
export function applyStageDirectionPreview(
  base: readonly StageSpeaker[],
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
  cues: unknown,
): StageSpeaker[] {
  if (!Array.isArray(cues)) return [...base];
  let actors = base.slice(0, MAX_SPRITE_SLOTS).map((actor) => ({ ...actor }));

  for (const rawCue of cues) {
    if (!rawCue || typeof rawCue !== "object" || Array.isArray(rawCue))
      continue;
    const cue = rawCue as Readonly<Record<string, unknown>>;
    const type = cue.type;
    if (type === "stage.clear") {
      const transition = isStageTransition(cue.transition)
        ? cue.transition
        : "fade";
      actors = actors.map((actor) => ({
        ...actor,
        exiting: true,
        transition,
      }));
      continue;
    }

    const matched = resolvePreviewActor(cue.character, actors, presenceMap);
    if (!matched) continue;
    const index = actors.findIndex((actor) => actor.id === matched.id);

    if (type === "actor.leave") {
      if (index >= 0) {
        actors[index] = {
          ...actors[index],
          exiting: true,
          transition: isStageTransition(cue.transition)
            ? cue.transition
            : (actors[index].transition ?? "fade"),
        };
      }
      continue;
    }
    if (type === "actor.focus") {
      if (index >= 0 && actors[index].exiting) continue;
      if (index > 0) {
        actors = [actors[index], ...actors.filter((_, i) => i !== index)];
      }
      continue;
    }
    if (type !== "actor.enter" && type !== "actor.update") continue;
    if (index < 0 && actors.length >= MAX_SPRITE_SLOTS) {
      const exitingIndex = actors.findIndex((actor) => actor.exiting);
      if (exitingIndex < 0) continue;
      actors.splice(exitingIndex, 1);
    }

    const current = index >= 0 ? actors[index] : matched;
    const visual = cueVisual(current.visual, cue);
    const position = isSpritePosition(cue.position)
      ? cue.position
      : current.position;
    const transition = isStageTransition(cue.transition)
      ? cue.transition
      : current.transition;
    const next: StageSpeaker = {
      id: matched.id,
      name: matched.name,
      ...(visual ? { visual } : {}),
      ...(position ? { position } : {}),
      ...(transition ? { transition } : {}),
    };
    if (position) {
      actors = actors.map((actor) => {
        if (actor.id === next.id || actor.position !== position) return actor;
        const { position: _position, ...rest } = actor;
        return rest;
      });
    }
    if (index >= 0) actors[index] = next;
    else actors.push(next);
    if (cue.focus === true) {
      const focusedIndex = actors.findIndex((actor) => actor.id === next.id);
      if (focusedIndex > 0) {
        actors = [
          actors[focusedIndex],
          ...actors.filter((_, i) => i !== focusedIndex),
        ];
      }
    }
  }

  return actors;
}
