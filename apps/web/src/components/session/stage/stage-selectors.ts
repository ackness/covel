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
  | "scene"
  | "previous-or-hero"
  | "hero"
  | "gradient";

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
  | "left"
  | "center-left"
  | "center"
  | "center-right"
  | "right";

export interface StageSpriteSlot {
  readonly characterId: string;
  readonly displayName: string;
  readonly ref: MediaRef;
  readonly active: boolean;
  readonly pos: SpritePosition;
}

const POSITIONS_BY_COUNT: Readonly<Record<number, readonly SpritePosition[]>> =
  {
    1: ["right"],
    2: ["left", "right"],
    3: ["left", "center", "right"],
    4: ["left", "center-left", "center-right", "right"],
  };

// ponytail: stage real estate caps at 4 sprites (scene-cast's default/typical
// activeSpeakerCount is 1-2); extend POSITIONS_BY_COUNT if a world ever needs more.
const MAX_SPRITE_SLOTS = 4;

/**
 * Station speakers on stage. Characters without a resolvable sprite/avatar
 * are dropped entirely (no empty-frame placeholder). `speakers[0]` (the
 * highest-salience speaker from scene-cast) is flagged `active` when it
 * survives filtering.
 */
export function computeSpriteSlots(
  speakers: readonly StageSpeaker[],
  presenceMap: Readonly<Record<string, PresenceRecord | undefined>>,
): StageSpriteSlot[] {
  const primaryId = speakers[0]?.id;

  const withMedia = speakers
    .map((speaker) => {
      const presence = presenceMap[speaker.id];
      const ref = isMediaRef(presence?.sprite)
        ? presence.sprite
        : isMediaRef(presence?.avatar)
          ? presence.avatar
          : null;
      return ref ? { speaker, ref } : null;
    })
    .filter(
      (entry): entry is { speaker: StageSpeaker; ref: MediaRef } =>
        entry !== null,
    )
    .slice(0, MAX_SPRITE_SLOTS);

  const positions = POSITIONS_BY_COUNT[withMedia.length] ?? [];

  return withMedia.map(({ speaker, ref }, index) => ({
    characterId: speaker.id,
    displayName: speaker.name,
    ref,
    active: speaker.id === primaryId,
    pos: positions[index] ?? "center",
  }));
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
      | Record<string, unknown>
      | undefined;

    result.push({
      blockId: msg.id,
      turnId: (meta.turnId as string | undefined) ?? msg.turnId ?? "",
      interactionId: (data.interactionId as string | undefined) ?? "choice",
      prompt: (data.prompt as string | undefined) ?? "",
      choices: (data.choices ?? []) as StageInteractionChoice["choices"],
      submitBehavior: rawBehavior
        ? {
            echoFilledNarrative: rawBehavior.echoFilledNarrative as
              | boolean
              | undefined,
          }
        : undefined,
    });
  }

  return result;
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
