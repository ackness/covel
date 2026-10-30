import { useContext } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  currentCharacterOf,
  isBaseActionKind,
  seatCharacterIds,
  type ActionKindDescriptor,
  type Seat,
  type TurnAction,
} from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  sessionCharacters,
  type SessionCharacter,
} from "@/lib/session-characters.js";
import { SessionStateContext } from "@/stores/session-store/context.js";

/** An answer to a choice or a form shows as the player's own text. */
const PLAIN_ANSWER_KINDS: ReadonlySet<string> = new Set(["say", "act"]);

/**
 * True for a single player's ordinary input, the case the server renders as
 * the text alone: a player seat that binds at most one character, the actions
 * taken as that character, and each a plain `say`, a slash command or a
 * `say` / `act` answer. The bubble then needs no "who and how".
 */
function isPlainInput(
  actions: readonly TurnAction[],
  seats: readonly Seat[],
  characters: readonly SessionCharacter[],
): boolean {
  const seatId = actions[0]?.seatId;
  if (seatId === undefined) return true;
  if (actions.some((action) => action.seatId !== seatId)) return false;
  const seat = seats.find((candidate) => candidate.id === seatId);
  if (!seat || seat.role !== "player") return false;
  if (seatCharacterIds(seat, characters, seats).length > 1) return false;
  const current = currentCharacterOf(seat, characters, seats)?.id;
  return actions.every(
    (action) =>
      (action.actorId === undefined || action.actorId === current) &&
      (action.interaction !== undefined
        ? PLAIN_ANSWER_KINDS.has(action.kind)
        : action.kind === "command" ||
          (action.kind === "say" && action.fields === undefined)),
  );
}

export interface PlayerLabelContext {
  readonly seats: readonly Seat[];
  readonly characters: readonly SessionCharacter[];
  readonly catalogue: readonly ActionKindDescriptor[];
  readonly language: string;
  readonly t: TFunction;
}

function kindLabel(kind: string, context: PlayerLabelContext): string {
  if (isBaseActionKind(kind)) return context.t(`session.actionKind.${kind}`);
  const declared = context.catalogue.find((entry) => entry.kind === kind);
  return (
    (declared &&
      resolveDisplayText(declared.display.label, context.language)) ||
    kind.slice(kind.indexOf("/") + 1)
  );
}

/**
 * Who acted and how, for a player's message: "<character> · <kind>" per
 * action, joined when there are several. `null` when the message has no
 * recorded actions or is the plain input above; the bubble then says
 * "Player". A character the game state does not know shows the kind alone.
 */
export function playerMessageLabel(
  actions: readonly TurnAction[] | undefined,
  context: PlayerLabelContext,
): string | null {
  if (!actions || actions.length === 0) return null;
  if (isPlainInput(actions, context.seats, context.characters)) return null;
  const labels: string[] = [];
  for (const action of actions) {
    const kind = kindLabel(action.kind, context);
    const actor = context.characters.find(
      (character) => character.id === action.actorId,
    )?.name;
    const label = actor ? `${actor} · ${kind}` : kind;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(", ");
}

/**
 * The name above a player's message. It reads the session state directly,
 * so only player messages follow it, and falls back to "Player" outside a
 * session.
 */
export function PlayerMessageLabel({
  actions,
}: {
  actions: readonly TurnAction[] | undefined;
}) {
  const { t, i18n } = useTranslation();
  const state = useContext(SessionStateContext);
  const label =
    state?.session && actions
      ? playerMessageLabel(actions, {
          seats: state.session.seats,
          characters: sessionCharacters(state.gameState),
          catalogue: state.sessionActionKinds?.kinds ?? [],
          language: i18n.language,
          t,
        })
      : null;
  return <>{label ?? t("session.player", "Player")}</>;
}
