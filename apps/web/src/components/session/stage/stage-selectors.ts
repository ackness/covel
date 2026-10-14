/**
 * Pure selectors for stage mode (viewMode: "stage"). No React, no store
 * subscriptions — callers (StageView etc.) read plugin-data namespaces via
 * kernel UI slots and pass presentation models here.
 */
import type { MediaRef, StageChoicesModel } from "@covel/shared";
import type { StreamMessage } from "@/stores/session-store.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { resolveI18n } from "@/lib/catalog/helpers.js";
import {
  resolveCharacterVisual,
  type CharacterVisualFraming,
  type PresenceRecord,
} from "@/lib/character-visuals.js";
import { isPendingInteractionMessage } from "../game-view/interaction-blocks.js";
import {
  MAX_SPRITE_SLOTS,
  type SpritePosition,
  type StageCurrentRecord,
  type StageSpeaker,
  type StageTransition,
} from "./stage-direction-selectors.js";

export {
  type SpritePosition,
  type StageCurrentRecord,
  type StageSpeaker,
  type StageTransition,
} from "./stage-direction-selectors.js";

/** Stable key for the story currently presented on stage. A turn id survives
 * the streaming-placeholder to durable-message swap; the message id covers
 * restored legacy rows without a turn id. */
export function stageStoryKey(
  message: Pick<StreamMessage, "id" | "turnId"> | undefined,
): string | undefined {
  return message ? (message.turnId ?? message.id) : undefined;
}

/** Durable history present when Stage mounts has already been read elsewhere.
 * A streaming placeholder can also be present on the first render, but its
 * partial narrative must still pass through the typewriter. */
export function initialStageReadStoryKey(
  message: Pick<StreamMessage, "id" | "turnId"> | undefined,
): string | undefined {
  return message?.id.startsWith("stream_") ? undefined : stageStoryKey(message);
}

// ── Backdrop (stage.backdrop@1) ──────────────────────

export type StageBackdropKind = "scene" | "hero" | "gradient";

export interface StageBackdrop {
  readonly kind: StageBackdropKind;
  /** MediaRef for "scene"; world header image URL for "hero". Absent otherwise. */
  readonly ref?: MediaRef | string;
}

/**
 * Backdrop fallback: scene art when the scene resolved to an image, otherwise
 * the world hero image (`worldVisual` always resolves to a real image;
 * "gradient" is kept in the type as the theoretical last resort but this
 * selector never returns it).
 */
export function resolveBackdrop(
  stageCurrent: StageCurrentRecord | null | undefined,
  worldVisual: WorldVisual,
): StageBackdrop {
  if (!stageCurrent) return { kind: "hero", ref: worldVisual.image };
  if (isMediaRef(stageCurrent.ref)) {
    return { kind: "scene", ref: stageCurrent.ref };
  }
  return { kind: "hero", ref: worldVisual.image };
}

// ── Sprites (stage.cast@1 × character.visual@1) ──
export type { PresenceRecord } from "@/lib/character-visuals.js";

export interface StageSpriteSlot {
  readonly characterId: string;
  readonly displayName: string;
  /** `null` when the speaker has no resolvable sprite/avatar — the sprite
   * layer renders a name-initial fallback card so the dialog nameplate never
   * points at an empty stage. */
  readonly ref: MediaRef | null;
  readonly variantId?: string;
  readonly framing?: CharacterVisualFraming;
  readonly transition?: StageTransition;
  readonly exiting?: boolean;
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
 * Sticky station assignment (classic-VN semantics): the cast's salience
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

/**
 * Lane geometry for the sprite layer: the stage splits into equal lanes,
 * one per staged sprite, ordered left→right by station rank.
 * Sprites render *contained inside* their lane box, so occlusion is
 * impossible by construction — sprite width is bounded by stage *width* (a
 * share of it), not by stage height × image aspect, which is what let wide
 * sprite cards swallow their neighbours whenever the stage got narrower.
 * Speaker focus is a presentation concern (filter / subtle scale / z-index),
 * not layout geometry: changing speakers must not make every sprite resize.
 *
 * Returns one lane per input position, aligned with input order. Assumes
 * positions are unique (guaranteed by `assignStations`).
 */
export function computeSpriteLanes(
  positions: readonly SpritePosition[],
): SpriteLane[] {
  const count = positions.length;
  if (count === 0) return [];
  const share = 100 / count;

  const byRank = positions
    .map((pos, i) => ({ i, station: STATION_ORDER.indexOf(pos) }))
    .sort((a, b) => a.station - b.station);
  const lanes = Array.from<SpriteLane>({ length: count });
  let cursor = 0;
  for (const { i } of byRank) {
    const widthPct = Math.min(share, MAX_SOLO_LANE_PCT);
    lanes[i] = { leftPct: cursor + (share - widthPct) / 2, widthPct };
    cursor += share;
  }
  return lanes;
}

/** Slot projections share the World Model character ID. */
function findPresence(
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
  speakerId: string,
): PresenceRecord | undefined {
  return presenceMap[speakerId];
}

/**
 * Station speakers on stage. Speakers without a resolvable sprite/avatar are
 * kept as `ref: null` slots (the sprite layer renders a fallback card) rather
 * than dropped — dropping the primary speaker left the dialog nameplate
 * pointing at nobody on stage. `speakers[0]` (the highest-salience speaker
 * from the stage.cast@1 value) is the fallback focus when no actor specifies `active`.
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
  const staged = speakers.slice(0, MAX_SPRITE_SLOTS);
  const hasExplicitFocus = staged.some(
    (speaker) => speaker.active !== undefined,
  );
  const primaryId = hasExplicitFocus
    ? undefined
    : staged.find((speaker) => !speaker.exiting)?.id;
  const resolved =
    stations ??
    assignStations(
      new Map(),
      staged.map((speaker) => speaker.id),
    );

  return staged.map((speaker) => {
    const presence = findPresence(presenceMap, speaker.id);
    const visual = resolveCharacterVisual(presence, speaker.visual);
    return {
      characterId: speaker.id,
      displayName: speaker.name,
      ref: visual?.ref ?? null,
      ...(visual?.variantId ? { variantId: visual.variantId } : {}),
      ...(visual?.stage ? { framing: visual.stage } : {}),
      ...(speaker.transition ? { transition: speaker.transition } : {}),
      ...(speaker.exiting ? { exiting: true } : {}),
      active: !speaker.exiting && (speaker.active ?? speaker.id === primaryId),
      pos: speaker.position ?? resolved.get(speaker.id) ?? "center",
    };
  });
}

// ── Choices (interaction.request choice blocks + stage.choices@1) ─────

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

    result.push({
      blockId: msg.id,
      turnId: (meta.turnId as string | undefined) ?? msg.turnId ?? "",
      interactionId: (data.interactionId as string | undefined) ?? "choice",
      prompt: (data.prompt as string | undefined) ?? "",
      choices: (data.choices ?? []) as StageInteractionChoice["choices"],
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

/**
 * Whether the player has submitted any form-type interaction. During
 * During setup this is the "opening form is done" signal — the stage mounts
 * from that moment instead of waiting for `phase === "playing"`, so
 * the scene (world hero backdrop until the narrator sets a real scene)
 * appears right after the player names their character.
 */
export function hasSubmittedForm(
  messages: readonly StreamMessage[],
  submittedBlockIds: ReadonlySet<string>,
): boolean {
  return messages.some(
    (msg) =>
      msg.block != null &&
      submittedBlockIds.has(msg.id) &&
      isFormBlock(msg.block as Record<string, unknown>),
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
    }
  | {
      readonly kind: "prompt";
      readonly id: string;
      /** Also the exact text to send via onSendMessage. */
      readonly label: string;
      readonly description?: string;
    };

/** A choice source and the question its entries answer. */
export interface StageChoiceGroup {
  readonly id: string;
  readonly prompt?: string;
  readonly items: readonly StageChoiceItem[];
}

/** Context shown above the stage decision controls. */
export interface StageDecisionContext {
  readonly scene?: string;
  readonly recap?: string;
  readonly decision?: string;
}

export interface MergedChoices {
  readonly items: readonly StageChoiceItem[];
  readonly groups: readonly StageChoiceGroup[];
  readonly context: StageDecisionContext;
  readonly twoColumn: boolean;
}

// Spec's "6 条以上双列" is read exclusively: ≤6 items stay single-column (still
// visually acceptable), 7+ go two-column. `items.length > 6` below.
const TWO_COLUMN_THRESHOLD = 6;

/**
 * Pending interaction choices come first, followed by the stage.choices@1
 * provider's choices in their declared order. Groups retain their question;
 * the flat items list supplies shared numbering and keyboard navigation.
 */
export function mergeChoices(
  interactionChoices: readonly StageInteractionChoice[],
  suggestions: StageChoicesModel | undefined,
  locale: string,
): MergedChoices {
  const items: StageChoiceItem[] = [];
  const groups: StageChoiceGroup[] = [];
  const interactionPrompts: string[] = [];

  for (const block of interactionChoices) {
    const groupItems: StageChoiceItem[] = [];
    for (const choice of block.choices) {
      const item: StageChoiceItem = {
        kind: "interaction",
        id: `${block.blockId}:${choice.id}`,
        label: choice.label,
        description: choice.description,
        blockId: block.blockId,
        turnId: block.turnId,
        interactionId: block.interactionId,
        choiceId: choice.id,
      };
      items.push(item);
      groupItems.push(item);
    }
    const prompt = block.prompt.trim() || undefined;
    if (prompt) interactionPrompts.push(prompt);
    if (groupItems.length > 0) {
      groups.push({
        id: `interaction:${block.blockId}`,
        prompt,
        items: groupItems,
      });
    }
  }

  const promptItems: StageChoiceItem[] = [];
  for (const choice of suggestions?.choices ?? []) {
    if (!choice.text.trim()) continue;
    const item: StageChoiceItem = {
      kind: "prompt",
      id: choice.id,
      label: choice.text.trim(),
      description: resolveI18n(choice.label, locale) || undefined,
    };
    items.push(item);
    promptItems.push(item);
  }

  const scene = resolveI18n(suggestions?.scene, locale).trim() || undefined;
  const recap = resolveI18n(suggestions?.recap, locale).trim() || undefined;
  const generatedDecision =
    resolveI18n(suggestions?.decision, locale).trim() || undefined;
  const decision =
    interactionPrompts.length === 1 ? interactionPrompts[0] : generatedDecision;

  if (promptItems.length > 0) {
    groups.push({
      id: "suggestions",
      prompt:
        interactionChoices.length > 0 && generatedDecision !== decision
          ? generatedDecision
          : undefined,
      items: promptItems,
    });
  }

  return {
    items,
    groups,
    context: { scene, recap, decision },
    twoColumn: items.length > TWO_COLUMN_THRESHOLD,
  };
}

/**
 * A stage.choices@1 value without turnId is unscoped under the current
 * optional-field contract. Turn-scoped choices require a matching story turn;
 * committed retries may resolve to that story's turn through resolveTurnId.
 * Interaction choices and the free-text composer are independent of this slot.
 */
export function filterStalePrompts(
  suggestions: StageChoicesModel | undefined,
  currentTurnId: string | undefined,
  resolveTurnId: (turnId: string) => string = (turnId) => turnId,
): StageChoicesModel | undefined {
  if (
    suggestions?.turnId !== undefined &&
    (currentTurnId === undefined ||
      resolveTurnId(suggestions.turnId) !== currentTurnId)
  )
    return undefined;
  return suggestions;
}
