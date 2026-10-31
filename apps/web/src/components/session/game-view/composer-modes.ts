/**
 * The composer's modes: the action kinds the player's seat may submit now,
 * read from the session's action-kind catalogue. A mode needs no declaration
 * of its own; the kind's `display` already names it.
 */
import {
  BASE_ACTION_KIND_RULES,
  composerFieldsOf,
  currentCharacterOf,
  primarySeat,
  seatCharacterIds,
  type ActionKindDescriptor,
  type ActionTextRule,
  type BaseActionKind,
  type ComposerField,
  type Seat,
  type SessionActionKindsResponse,
} from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import type { SessionCharacter } from "@/lib/session-characters.js";

export interface ComposerMode {
  /** Wire kind: a base kind or `<pluginId>/<name>`. */
  readonly kind: string;
  readonly label: string;
  readonly icon?: string;
  readonly placeholder?: string;
  readonly text: ActionTextRule;
  /** Whether the action is taken as a character, so the switcher applies. */
  readonly actor: boolean;
  readonly fields: readonly ComposerField[];
}

/** The seat the composer acts for: the primary seat, else a human one. */
export function composerSeat(seats: readonly Seat[]): Seat | undefined {
  return (
    primarySeat(seats) ?? seats.find((seat) => seat.controller === "human")
  );
}

/** Slash commands keep their `/` path, so `command` is never a mode. */
function isOfferedKind(kind: string): boolean {
  return kind !== "command";
}

export interface DeriveModesInput {
  readonly catalogue: SessionActionKindsResponse | null;
  readonly seats: readonly Seat[];
  readonly language: string;
  readonly baseLabel: (kind: BaseActionKind) => string;
}

function modeOf(
  descriptor: ActionKindDescriptor,
  input: DeriveModesInput,
): ComposerMode | null {
  const fields = descriptor.fieldsSchema
    ? composerFieldsOf(descriptor.fieldsSchema)
    : [];
  // A schema the composer cannot draw hides the kind rather than showing
  // half a form; an interaction can still submit it.
  if (fields === null) return null;
  const base = descriptor.source === "framework";
  const placeholder = resolveDisplayText(
    descriptor.display.placeholder,
    input.language,
  );
  return {
    kind: descriptor.kind,
    label: base
      ? input.baseLabel(descriptor.kind as BaseActionKind)
      : resolveDisplayText(descriptor.display.label, input.language) ||
        descriptor.kind,
    ...(descriptor.display.icon ? { icon: descriptor.display.icon } : {}),
    ...(placeholder ? { placeholder } : {}),
    text: descriptor.text,
    actor: descriptor.actor,
    fields,
  };
}

/**
 * The modes for the composer's seat, `say` first and then the other allowed
 * kinds in catalogue order (base kinds, then plugin kinds). Without a
 * catalogue, or without a seat the catalogue knows, only `say` is offered.
 */
export function deriveComposerModes(input: DeriveModesInput): ComposerMode[] {
  const say: ComposerMode = {
    kind: "say",
    label: input.baseLabel("say"),
    text: BASE_ACTION_KIND_RULES.say.text,
    actor: BASE_ACTION_KIND_RULES.say.actor,
    fields: [],
  };
  const seat = composerSeat(input.seats);
  const allowed = new Set(
    input.catalogue?.seats.find((entry) => entry.seatId === seat?.id)?.allowed,
  );
  if (!input.catalogue || !seat || allowed.size === 0) return [say];
  const modes = input.catalogue.kinds.flatMap((descriptor) => {
    if (!allowed.has(descriptor.kind) || !isOfferedKind(descriptor.kind))
      return [];
    const mode = modeOf(descriptor, input);
    return mode ? [mode] : [];
  });
  modes.sort((a, b) => Number(b.kind === "say") - Number(a.kind === "say"));
  return modes.length > 0 ? modes : [say];
}

export interface CharacterSwitcherModel {
  readonly seatId: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly currentId: string | undefined;
}

/**
 * The seat's bound characters for the switcher; `null` unless it binds two
 * or more. A character the game state has no name for shows its ID's place
 * as an empty name, which the control replaces with a placeholder.
 */
export function characterSwitcherOf(
  seats: readonly Seat[],
  characters: readonly SessionCharacter[],
): CharacterSwitcherModel | null {
  const seat = composerSeat(seats);
  if (!seat) return null;
  const bound = seatCharacterIds(seat, characters, seats);
  if (bound.length < 2) return null;
  const byId = new Map(
    characters.map((character) => [character.id, character]),
  );
  return {
    seatId: seat.id,
    options: bound.map((id) => ({ id, name: byId.get(id)?.name ?? "" })),
    currentId: currentCharacterOf(seat, characters, seats)?.id,
  };
}

/** Whether a submission of `kind` with this text can be sent. */
export function modeAcceptsInput(mode: ComposerMode, text: string): boolean {
  if (mode.text === "none") return true;
  if (text.trim().length > 0) return true;
  return mode.text === "optional" && mode.fields.length > 0;
}
