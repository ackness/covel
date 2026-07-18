/**
 * Pure selectors for stage mode (viewMode: "stage"). No React, no store
 * subscriptions — callers (StageView etc.) read plugin-data namespaces via
 * `usePluginNamespace` and hand the raw records here.
 */
import type { MediaRef } from "@covel/shared";
import type { StreamMessage } from "@/stores/session-store.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import { isPendingInteractionMessage } from "../game-view/interaction-blocks.js";

// ── Capability-driven plugin binding ────────────────────────────
//
// Stage layers bind to plugin-data by CAPABILITY, not by hardcoded plugin id
// (framework↔plugin isolation rule — framework code must discover plugins via
// declared capabilities). A plugin declares one of these capabilities in its
// PLUGIN.md; the stage resolves the owning plugin id at runtime from the
// session's active plugin list. The bundled plugins (scene-stage / scene-cast /
// scene-prompts / character-presence) declare the matching capability, so
// discovery resolves to them today; a third-party equivalent that declares the
// same capability transparently replaces them without touching this code.

export const STAGE_CAPABILITIES = {
  scene: "scene-stage",
  cast: "scene-cast",
  prompts: "scene-prompts",
  presence: "character-presence",
} as const;

interface CapabilityCarrier {
  readonly id: string;
  readonly isActive?: boolean;
  readonly capabilities?: readonly string[];
}

/**
 * Resolve the ACTIVE plugin id that declares `capability` from the session's
 * plugin list. Only an active plugin writes plugin-data, so binding a stage
 * layer to an inactive (or absent) provider yields a permanently empty layer —
 * return `undefined` in that case and let the caller disable the layer
 * gracefully rather than guessing the capability name as a plugin id.
 *
 * Deterministic when several active plugins declare the same capability: pick
 * the lexicographically smallest id, so the choice never depends on the
 * server's plugin-list ordering (stage layers are 1:1).
 */
export function pluginIdForCapability(
  plugins: readonly CapabilityCarrier[],
  capability: string,
): string | undefined {
  let best: string | undefined;
  for (const p of plugins) {
    if (!p.isActive || !p.capabilities?.includes(capability)) continue;
    if (best === undefined || p.id < best) best = p.id;
  }
  return best;
}

// ── Backdrop (scene-stage `stage/current`) ──────────────────────

/** Shape written by `scene-stage/resolver` to `(scene-stage, "stage")["current"]`. */
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

export type StageBackdropKind =
  "scene" | "previous-or-hero" | "hero" | "gradient";

export interface StageBackdrop {
  readonly kind: StageBackdropKind;
  /** MediaRef for "scene"; world header image URL for "hero". Absent otherwise. */
  readonly ref?: MediaRef | string;
  readonly pendingBadge?: boolean;
}

/**
 * Four-tier backdrop fallback (spec §4: "none" and "no scene-stage data at
 * all" share the same fallback chain — world hero image first, since
 * `worldVisual` always resolves to a real image; "gradient" is kept in the
 * type as the theoretical last resort but this selector never returns it).
 */
export function resolveBackdrop(
  stageCurrent: StageCurrentRecord | null | undefined,
  worldVisual: WorldVisual,
): StageBackdrop {
  if (!stageCurrent) return { kind: "hero", ref: worldVisual.image };
  if (isMediaRef(stageCurrent.resolved)) {
    return { kind: "scene", ref: stageCurrent.resolved };
  }
  if (stageCurrent.source === "pending") {
    return { kind: "previous-or-hero", pendingBadge: true };
  }
  return { kind: "hero", ref: worldVisual.image };
}

// ── Sprites (scene-cast `active-cast` × character-presence `presence`) ──

export interface StageSpeaker {
  readonly id: string;
  readonly name: string;
}

/** Presence record shape — mirrors `portrait-gallery-panel.tsx`'s local type. */
export interface PresenceRecord {
  readonly characterId?: string;
  readonly displayName?: string;
  readonly avatar?: unknown;
  readonly sprite?: unknown;
}

export type SpritePosition =
  "left" | "center-left" | "center" | "center-right" | "right";

export interface StageSpriteSlot {
  readonly characterId: string;
  readonly displayName: string;
  /** `null` when the speaker has no resolvable sprite/avatar — the sprite
   * layer renders a name-initial fallback card so the dialog nameplate never
   * points at an empty stage. */
  readonly ref: MediaRef | null;
  readonly active: boolean;
  readonly pos: SpritePosition;
}

/** Spatial scale of the five stations, left→right — index distance on this
 * array is the visual distance a sprite travels when re-stationed. */
const STATION_ORDER: readonly SpritePosition[] = [
  "left",
  "center-left",
  "center",
  "center-right",
  "right",
];

/** Which stations are *in play* for a cast size (set semantics — assignment
 * order comes from `assignStations`, not from array order). Solo speaker
 * stands centered, fully visible (player feedback overrode the spec's
 * original right-side station). */
const STATIONS_BY_COUNT: Readonly<Record<number, readonly SpritePosition[]>> = {
  1: ["center"],
  2: ["left", "right"],
  3: ["left", "center", "right"],
  4: ["left", "center-left", "center-right", "right"],
};

// ponytail: stage real estate caps at 4 sprites (scene-cast's default/typical
// activeSpeakerCount is 1-2); extend STATIONS_BY_COUNT if a world ever needs more.
export const MAX_SPRITE_SLOTS = 4;

/** Leftmost free station nearest to `target` (ties break left — the
 * left-to-right STATION_ORDER walk with a strict `<` guarantees it). */
function nearestFree(
  free: ReadonlySet<SpritePosition>,
  target: SpritePosition,
): SpritePosition {
  const targetIdx = STATION_ORDER.indexOf(target);
  let best: SpritePosition = "center";
  let bestDist = Infinity;
  for (const [idx, pos] of STATION_ORDER.entries()) {
    if (!free.has(pos)) continue;
    const dist = Math.abs(idx - targetIdx);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Sticky station assignment (classic-VN semantics): scene-cast's salience
 * order decides who is *on* stage and who is highlighted — never where
 * anyone stands. Stations only reshuffle when the cast membership changes
 * (someone enters or leaves), and even then movement is minimised:
 *
 * 1. Whoever already holds a station that's still in play keeps it.
 * 2. Everyone else (in salience order) walks to the free station nearest
 *    their target — their remembered spot if they have one, stage center
 *    otherwise. One rule covers both "step aside" (the station set shrank
 *    or grew) and "enter" (newcomers gravitate to center, so the fresh
 *    layout naturally centers the primary speaker).
 * 3. Off-stage memory survives (map is bounded by distinct cast size), so a
 *    character who re-enters later prefers their old spot.
 * 4. An empty cast (transitional narration turn) returns `previous`
 *    untouched — the sprite layer shows the sticky line-up, and the
 *    returning cast must land on their old spots, not a fresh layout.
 *
 * Pure and idempotent: `assignStations(assignStations(m, ids), ids)` is a
 * fixpoint, so the caller may safely re-run it per render (StrictMode).
 */
export function assignStations(
  previous: ReadonlyMap<string, SpritePosition>,
  speakerIds: readonly string[],
): ReadonlyMap<string, SpritePosition> {
  const staged = speakerIds.slice(0, MAX_SPRITE_SLOTS);
  if (staged.length === 0) return previous;

  const free = new Set(STATIONS_BY_COUNT[staged.length] ?? []);
  const next = new Map<string, SpritePosition>();

  for (const id of staged) {
    const remembered = previous.get(id);
    if (remembered && free.has(remembered)) {
      next.set(id, remembered);
      free.delete(remembered);
    }
  }
  for (const id of staged) {
    if (next.has(id)) continue;
    const pos = nearestFree(free, previous.get(id) ?? "center");
    next.set(id, pos);
    free.delete(pos);
  }
  for (const [id, pos] of previous) {
    if (!next.has(id)) next.set(id, pos);
  }
  return next;
}

export interface SpriteLane {
  /** Lane box left edge, percent of stage width. */
  readonly leftPct: number;
  /** Lane box width, percent of stage width. */
  readonly widthPct: number;
}

/** A lone sprite gets the whole stage as its lane — cap it so a wide
 * (non-transparent, scene-baked) card can't blanket the entire backdrop. */
const MAX_SOLO_LANE_PCT = 60;

/** Active speaker's lane share relative to the others'. Equal lanes let a
 * wide (width-bound, `object-contain`) speaker sprite render *smaller* than
 * tall neighbours; the extra share keeps the speaker visually dominant.
 * Must stay small enough that a 2-cast active lane (w/(w+1)) ≤ the solo cap. */
const ACTIVE_LANE_WEIGHT = 1.4;

/**
 * Lane geometry for the sprite layer: the stage splits into weighted lanes,
 * one per staged sprite, ordered left→right by station rank — the active
 * speaker (when there is one and the cast isn't solo) gets a wider share.
 * Sprites render *contained inside* their lane box, so occlusion is
 * impossible by construction — sprite width is bounded by stage *width* (a
 * share of it), not by stage height × image aspect, which is what let wide
 * sprite cards swallow their neighbours whenever the stage got narrower.
 *
 * Returns one lane per input position, aligned with input order. Assumes
 * positions are unique (guaranteed by `assignStations`).
 */
export function computeSpriteLanes(
  positions: readonly SpritePosition[],
  activeIndex = -1,
): SpriteLane[] {
  const count = positions.length;
  if (count === 0) return [];
  const weights = positions.map((_, i) =>
    i === activeIndex && count > 1 ? ACTIVE_LANE_WEIGHT : 1,
  );
  const total = weights.reduce((sum, w) => sum + w, 0);

  const byRank = positions
    .map((pos, i) => ({ i, station: STATION_ORDER.indexOf(pos) }))
    .sort((a, b) => a.station - b.station);
  const lanes: SpriteLane[] = new Array(count);
  let cursor = 0;
  for (const { i } of byRank) {
    const share = (weights[i] / total) * 100;
    const widthPct = Math.min(share, MAX_SOLO_LANE_PCT);
    lanes[i] = { leftPct: cursor + (share - widthPct) / 2, widthPct };
    cursor += share;
  }
  return lanes;
}

/**
 * Reconcile scoped speaker ids against bare presence characterIds. scene-cast
 * keys speakers by `<sessionId>-<characterId>` (scopedCharacterId) while
 * character-presence keys its records by the bare `characterId`, so a direct
 * `presenceMap[speaker.id]` lookup always misses. Match on the presence
 * *value*'s characterId by exact id or the `-<characterId>` suffix — mirrors
 * `resolveCharacterAvatar` in lib/catalog.
 */
function findPresence(
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
  speakerId: string,
): PresenceRecord | undefined {
  for (const value of Object.values(presenceMap)) {
    const pid = value?.characterId;
    if (!pid) continue;
    if (speakerId === pid || speakerId.endsWith(`-${pid}`)) return value;
  }
  return undefined;
}

/**
 * Station speakers on stage. Speakers without a resolvable sprite/avatar are
 * kept as `ref: null` slots (the sprite layer renders a fallback card) rather
 * than dropped — dropping the primary speaker left the dialog nameplate
 * pointing at nobody on stage. `speakers[0]` (the highest-salience speaker
 * from scene-cast) is always flagged `active`.
 *
 * `stations` is the sticky assignment from {@link assignStations} — pass the
 * previous render's map through it so sprites keep their spots across speaker
 * switches. Omitting it computes a fresh (memory-less) layout.
 */
export function computeSpriteSlots(
  speakers: readonly StageSpeaker[],
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
  stations?: ReadonlyMap<string, SpritePosition>,
): StageSpriteSlot[] {
  const primaryId = speakers[0]?.id;
  const staged = speakers.slice(0, MAX_SPRITE_SLOTS);
  const resolved =
    stations ??
    assignStations(
      new Map(),
      staged.map((speaker) => speaker.id),
    );

  return staged.map((speaker) => {
    const presence = findPresence(presenceMap, speaker.id);
    const ref = isMediaRef(presence?.sprite)
      ? presence.sprite
      : isMediaRef(presence?.avatar)
        ? presence.avatar
        : null;
    return {
      characterId: speaker.id,
      displayName: speaker.name,
      ref,
      active: speaker.id === primaryId,
      pos: resolved.get(speaker.id) ?? "center",
    };
  });
}

// ── Choices (interaction.request choice blocks + scene-prompts) ─────

/** One pending choice-type interaction block, ready to flatten into items. */
export interface StageInteractionChoice {
  readonly blockId: string;
  readonly turnId: string;
  readonly interactionId: string;
  readonly prompt: string;
  readonly choices: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly submitBehavior?: { readonly echoFilledNarrative?: boolean };
}

/**
 * Find unsubmitted choice-type interaction blocks in the message list
 * (same "pending" rule as the parsed chat view: not yet submitted, and no
 * later player message has superseded it).
 */
export function extractInteractionChoices(
  messages: readonly StreamMessage[],
  submittedBlockIds: ReadonlySet<string>,
): StageInteractionChoice[] {
  const result: StageInteractionChoice[] = [];

  for (const msg of messages) {
    if (!msg.block) continue;
    if (
      !isPendingInteractionMessage(
        msg,
        messages as StreamMessage[],
        submittedBlockIds,
      )
    ) {
      continue;
    }

    const block = msg.block;
    const data = (block.data ?? block) as Record<string, unknown>;
    const type = block.type as string | undefined;
    const innerType = data.type as string | undefined;
    if (innerType !== "choice" && type !== "interactive_choice") continue;

    const meta = (block.meta ?? {}) as Record<string, unknown>;
    const rawBehavior = data.submitBehavior as
      Record<string, unknown> | undefined;

    result.push({
      blockId: msg.id,
      turnId: (meta.turnId as string | undefined) ?? msg.turnId ?? "",
      interactionId: (data.interactionId as string | undefined) ?? "choice",
      prompt: (data.prompt as string | undefined) ?? "",
      choices: (data.choices ?? []) as StageInteractionChoice["choices"],
      submitBehavior: rawBehavior
        ? {
            echoFilledNarrative: rawBehavior.echoFilledNarrative as
              boolean | undefined,
          }
        : undefined,
    });
  }

  return result;
}

/**
 * Pending form-type interaction messages (the stage dialog can only take
 * choices and free text inline, so forms are surfaced in a modal). Same
 * "pending" rule as {@link extractInteractionChoices}, but keeps the full
 * `StreamMessage` because `MessageBlockRenderer` needs `msg` + `block`.
 */
export function extractPendingFormMessages(
  messages: readonly StreamMessage[],
  submittedBlockIds: ReadonlySet<string>,
): StreamMessage[] {
  return messages.filter(
    (msg) =>
      isPendingInteractionMessage(
        msg,
        messages as StreamMessage[],
        submittedBlockIds,
      ) && isFormBlock(msg.block as Record<string, unknown>),
  );
}

function isFormBlock(block: Record<string, unknown>): boolean {
  const data = (block.data ?? block) as Record<string, unknown>;
  return (
    data.type === "form" ||
    block.type === "interactive_form" ||
    (Array.isArray(data.fields) && data.fields.length > 0)
  );
}

/** A single renderable entry in the stage choice overlay. */
export type StageChoiceItem =
  | {
      readonly kind: "interaction";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly blockId: string;
      readonly turnId: string;
      readonly interactionId: string;
      readonly choiceId: string;
      readonly submitBehavior?: { readonly echoFilledNarrative?: boolean };
    }
  | {
      readonly kind: "prompt";
      readonly id: string;
      /** Also the exact text to send via onSendMessage. */
      readonly label: string;
      readonly description?: string;
    };

export interface MergedChoices {
  readonly items: readonly StageChoiceItem[];
  readonly twoColumn: boolean;
}

const MAX_PROMPT_SLOTS = 6;
// Spec's "6 条以上双列" is read exclusively: ≤6 items stay single-column (still
// visually acceptable), 7+ go two-column. `items.length > 6` below.
const TWO_COLUMN_THRESHOLD = 6;

/**
 * Order: pending interaction choices, then scene-prompts short phrases
 * (unpacked from `prompt{N}Text/Label`, N sorted ascending, empty slots
 * skipped). The caller appends the "✎ free input" entry itself.
 *
 * ponytail: `prompt{N}Icon/Color` are left unpacked — v1 has no consumer for
 * them (plan's explicit scope cut); add when a component wants icon/color.
 */
export function mergeChoices(
  interactionChoices: readonly StageInteractionChoice[],
  promptsNamespace: Readonly<Record<string, unknown>>,
  locale: string,
): MergedChoices {
  const items: StageChoiceItem[] = [];

  for (const block of interactionChoices) {
    for (const choice of block.choices) {
      items.push({
        kind: "interaction",
        id: `${block.blockId}:${choice.id}`,
        label: choice.label,
        description: choice.description,
        blockId: block.blockId,
        turnId: block.turnId,
        interactionId: block.interactionId,
        choiceId: choice.id,
        submitBehavior: block.submitBehavior,
      });
    }
  }

  for (let n = 1; n <= MAX_PROMPT_SLOTS; n += 1) {
    const text = promptsNamespace[`prompt${n}Text`];
    if (typeof text !== "string" || text.trim().length === 0) continue;
    items.push({
      kind: "prompt",
      id: `prompt:${n}`,
      label: text,
      description:
        resolveI18n(promptsNamespace[`prompt${n}Label`], locale) || undefined,
    });
  }

  return { items, twoColumn: items.length > TWO_COLUMN_THRESHOLD };
}

/**
 * scene-prompts stamps its `message` namespace with the `__turnId` that
 * produced the phrases. Once the story advances, the old prompts linger until
 * scene-prompts regenerates — drop them so the stage never offers phrases from
 * a past turn. Returns the namespace untouched when the stamp is fresh, absent,
 * or uncomparable (no current turn yet) — the latter two keep back-compat with
 * pre-`__turnId` data. Interaction choices and the ✎ entry are unaffected
 * (they don't live in this namespace).
 */
export function filterStalePrompts(
  promptsNamespace: Readonly<Record<string, unknown>>,
  currentTurnId: string | undefined,
): Readonly<Record<string, unknown>> {
  const stamp = promptsNamespace.__turnId;
  if (typeof stamp === "string" && currentTurnId && stamp !== currentTurnId) {
    return {};
  }
  return promptsNamespace;
}
