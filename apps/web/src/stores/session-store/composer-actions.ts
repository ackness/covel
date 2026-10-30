/**
 * The actions a composer submission sends, and the local echo of the player's
 * message. The request a plain `say` produces is exactly what the composer
 * sent before it had modes.
 */
import {
  BASE_ACTION_KIND_RULES,
  currentCharacterOf,
  isBaseActionKind,
  primarySeat,
  type ActionKindDescriptor,
  type Seat,
  type SeatCharacter,
  type TurnAction,
  type TurnActionRequest,
} from "@covel/shared";

/** The structured fields of an action. */
export type ActionFields = NonNullable<TurnActionRequest["fields"]>;

/** What the composer or the stage free input submits as one player action. */
export interface ComposerSubmission {
  readonly kind: string;
  readonly text?: string;
  readonly fields?: ActionFields;
  /** Left out for the primary seat, which the server defaults to. */
  readonly seatId?: string;
}

/** Text the player typed: a line starting with `/` is a command, else a `say`. */
export function textActions(content: string): TurnActionRequest[] {
  return [{ kind: content.startsWith("/") ? "command" : "say", text: content }];
}

/**
 * The request actions of one submission. Queued selections ride along as a
 * `say` ahead of an action that is not itself a `say`.
 */
export function composerActions(
  submission: ComposerSubmission,
  drafts?: string,
): TurnActionRequest[] {
  const seat = submission.seatId ? { seatId: submission.seatId } : {};
  const action: TurnActionRequest = {
    kind: submission.kind,
    ...(submission.text !== undefined ? { text: submission.text } : {}),
    ...(submission.fields !== undefined ? { fields: submission.fields } : {}),
    ...seat,
  };
  return drafts ? [{ kind: "say", text: drafts, ...seat }, action] : [action];
}

function actorKind(
  kind: string,
  catalogue: readonly ActionKindDescriptor[] | undefined,
): boolean {
  const declared = catalogue?.find((entry) => entry.kind === kind);
  if (declared) return declared.actor;
  return isBaseActionKind(kind) ? BASE_ACTION_KIND_RULES[kind].actor : false;
}

/**
 * The actions as the server will resolve them, for the local echo: the seat
 * (the primary one unless named) and the character it currently acts as.
 */
export function echoedActions(
  requests: readonly TurnActionRequest[],
  context: {
    readonly seats: readonly Seat[];
    readonly characters: readonly SeatCharacter[];
    readonly catalogue?: readonly ActionKindDescriptor[];
  },
): TurnAction[] {
  return requests.map((request) => {
    const seat =
      context.seats.find((candidate) => candidate.id === request.seatId) ??
      primarySeat(context.seats);
    const actorId =
      request.actorId ??
      (actorKind(request.kind, context.catalogue)
        ? currentCharacterOf(seat, context.characters, context.seats)?.id
        : undefined);
    return {
      ...request,
      ...(seat ? { seatId: seat.id } : {}),
      ...(actorId !== undefined ? { actorId } : {}),
      source: "player",
    } as TurnAction;
  });
}

function fieldSummary(fields: ActionFields): string {
  return Object.entries(fields)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(", ");
}

/**
 * What the echoed bubble shows: the texts, one per line, as the server's
 * chat row does. A plugin kind without text shows its fields, and an action
 * with neither (an `advance`) has no bubble.
 */
export function echoContent(requests: readonly TurnActionRequest[]): string {
  const texts = requests
    .map((request) => request.text ?? "")
    .filter((text) => text.length > 0);
  if (texts.length > 0) return texts.join("\n");
  return requests
    .filter((request) => !isBaseActionKind(request.kind))
    .map((request) => fieldSummary(request.fields ?? {}))
    .filter((summary) => summary.length > 0)
    .join("\n");
}

/** A stopped submission, split the way the composer holds its inputs. */
export interface StoppedSubmission {
  /** What goes back into the input line. */
  readonly text: string;
  /** The mode to select again; a plain `say` needs none. */
  readonly kind?: string;
  readonly fields?: ActionFields;
  /** Queued selections that rode ahead of a non-`say` action. */
  readonly drafts?: string;
}

/**
 * What the composer takes back when a submission stopped before it started,
 * so sending it again produces the same actions. The echoed bubble joins the
 * queued selections and the typed line, and shows a fields-only action as a
 * summary; neither is what the player typed, so the split comes from the
 * actions themselves. In `say` the joined text is the request, so it goes
 * back as one line.
 */
export function stoppedSubmissionOf(
  actions: readonly Pick<TurnActionRequest, "kind" | "text" | "fields">[],
): StoppedSubmission {
  const last = actions.at(-1);
  const texts = (items: typeof actions) =>
    items
      .map((action) => action.text ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
  if (!last || last.kind === "say" || last.kind === "command")
    return {
      text: texts(actions),
      ...(last?.kind === "say" ? { kind: "say" } : {}),
    };
  const drafts = texts(actions.slice(0, -1));
  return {
    text: last.text ?? "",
    kind: last.kind,
    ...(last.fields ? { fields: last.fields } : {}),
    ...(drafts ? { drafts } : {}),
  };
}
