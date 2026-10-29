/**
 * `submit_actions`: check a player's actions against the session and fill in
 * their defaults.
 *
 * The checks run in a fixed order, and the first failure refuses the whole
 * submission before anything is stored:
 *
 *   1. the request schema (`validateActionRequest`, before this module);
 *   2. the seat exists (`seat_not_found`, 404);
 *   3. the seat has a human controller (`seat_not_human`, 409);
 *   4. the kind is in the session catalogue (`unknown_action_kind`, 409);
 *   5. the seat's role may submit it (`action_kind_not_allowed`, 409);
 *   6. the actor is bound to the seat, or absent for a kind without one
 *      (`actor_not_bound`, 409);
 *   7. the kind's text rule, and for an interaction answer the kind its
 *      committed interaction declares (`invalid_action`, 400);
 *   8. the fields match the kind (`invalid_action_fields`, 400).
 *
 * Interaction answers then go through the interaction submitter, which keeps
 * its own errors. The route runs these checks once before its stream opens,
 * for an HTTP status, and again under the session lock against the live
 * session.
 */

import {
  currentCharacterOf,
  interactionActionKind,
  isBaseActionKind,
  primarySeat,
  seatCharacterIds,
  type ActionKindDescriptor,
  type I18nText,
  type Seat,
  type SeatCharacter,
  type TurnAction,
  type TurnActionRequest,
} from "@covel/shared";
import { validateOutput } from "@covel/tools";

export type ActionValidationStatus = 400 | 404 | 409;

/** A refused submission: nothing of it was stored. */
export class ActionValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: ActionValidationStatus,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ActionValidationError";
  }
}

export interface ResolveActionsInput {
  readonly requests: readonly TurnActionRequest[];
  readonly seats: readonly Seat[];
  readonly characters: readonly SeatCharacter[];
  readonly kinds: readonly ActionKindDescriptor[];
  /**
   * The kinds the answered interactions declare, by `interactionKey`. An
   * interaction missing here takes its type's default; the interaction
   * submitter refuses one that was never committed.
   */
  readonly interactionKinds?: ReadonlyMap<string, string>;
}

/** The key of one committed interaction in `interactionKinds`. */
export function interactionKey(turnId: string, interactionId: string): string {
  return `${turnId}\0${interactionId}`;
}

function resolveSeat(
  request: TurnActionRequest,
  seats: readonly Seat[],
  position: string,
): Seat {
  if (request.seatId === undefined) {
    const seat = primarySeat(seats);
    if (!seat)
      throw new ActionValidationError(
        `${position}: the session has no human player seat; name the seat with seatId`,
        "seat_not_found",
        404,
      );
    return seat;
  }
  const seat = seats.find((candidate) => candidate.id === request.seatId);
  if (!seat)
    throw new ActionValidationError(
      `${position}: seat not found: ${request.seatId}`,
      "seat_not_found",
      404,
    );
  return seat;
}

function resolveActor(
  request: TurnActionRequest,
  descriptor: ActionKindDescriptor,
  input: ResolveActionsInput,
  seat: Seat,
  position: string,
): string | undefined {
  if (!descriptor.actor) {
    if (request.actorId !== undefined)
      throw new ActionValidationError(
        `${position}: kind ${descriptor.kind} is not taken as a character; leave out actorId`,
        "actor_not_bound",
        409,
      );
    return undefined;
  }
  if (request.actorId === undefined)
    return currentCharacterOf(seat, input.characters, input.seats)?.id;
  if (
    !seatCharacterIds(seat, input.characters, input.seats).includes(
      request.actorId,
    )
  )
    throw new ActionValidationError(
      `${position}: character ${request.actorId} is not bound to seat ${seat.id}`,
      "actor_not_bound",
      409,
    );
  return request.actorId;
}

function checkText(
  request: TurnActionRequest,
  descriptor: ActionKindDescriptor,
  input: ResolveActionsInput,
  position: string,
): void {
  const invalid = (problem: string) =>
    new ActionValidationError(`${position}: ${problem}`, "invalid_action", 400);
  if (request.interaction) {
    const { turnId, interactionId, type } = request.interaction;
    const expected = interactionActionKind(
      type,
      input.interactionKinds?.get(interactionKey(turnId, interactionId)),
    );
    if (request.kind !== expected)
      throw invalid(
        `an answer to a ${request.interaction.type} is submitted as kind ${expected}`,
      );
    if (request.text !== undefined)
      throw invalid(
        "an interaction answer carries no text; its narrative is filled from the answer",
      );
    return;
  }
  if (descriptor.text === "none" && request.text !== undefined)
    throw invalid(`kind ${descriptor.kind} carries no text`);
  if (descriptor.text === "required" && !request.text?.trim())
    throw invalid(`kind ${descriptor.kind} needs text`);
  if (descriptor.kind === "command" && !request.text?.startsWith("/"))
    throw invalid("command text starts with /");
}

function checkFields(
  request: TurnActionRequest,
  descriptor: ActionKindDescriptor,
  position: string,
): void {
  // An interaction answer's values are checked by the interaction submitter.
  if (request.interaction) return;
  const schema = descriptor.fieldsSchema;
  if (!schema) {
    if (request.fields !== undefined)
      throw new ActionValidationError(
        `${position}: kind ${descriptor.kind} takes no fields`,
        "invalid_action_fields",
        400,
      );
    return;
  }
  let result: ReturnType<typeof validateOutput>;
  try {
    result = validateOutput(request.fields ?? {}, schema);
  } catch {
    throw new ActionValidationError(
      `${position}: the fields schema of kind ${descriptor.kind} cannot be used`,
      "invalid_action_fields",
      400,
    );
  }
  if (!result.valid)
    throw new ActionValidationError(
      `${position}: fields do not match kind ${descriptor.kind}: ${(result.errors ?? []).join("; ")}`,
      "invalid_action_fields",
      400,
      { errors: result.errors ?? [] },
    );
}

/**
 * The resolved actions of a submission, in order: `seatId` and `source` set,
 * `actorId` filled for kinds taken as a character. Throws
 * `ActionValidationError` on the first check that fails.
 */
export function resolveSubmittedActions(
  input: ResolveActionsInput,
): TurnAction[] {
  const byKind = new Map(input.kinds.map((kind) => [kind.kind, kind]));
  const actions = input.requests.map((request, index): TurnAction => {
    const position = `actions[${index}]`;
    const seat = resolveSeat(request, input.seats, position);
    if (seat.controller !== "human")
      throw new ActionValidationError(
        `${position}: seat ${seat.id} has no human controller`,
        "seat_not_human",
        409,
      );
    const descriptor = byKind.get(request.kind);
    if (!descriptor)
      throw new ActionValidationError(
        `${position}: this session has no action kind ${request.kind}`,
        "unknown_action_kind",
        409,
      );
    if (!descriptor.roles.includes(seat.role))
      throw new ActionValidationError(
        `${position}: a ${seat.role} seat may not submit ${request.kind}`,
        "action_kind_not_allowed",
        409,
      );
    const actorId = resolveActor(request, descriptor, input, seat, position);
    checkText(request, descriptor, input, position);
    checkFields(request, descriptor, position);
    return {
      seatId: seat.id,
      kind: request.kind,
      ...(actorId !== undefined ? { actorId } : {}),
      ...(request.text !== undefined ? { text: request.text } : {}),
      ...(request.fields !== undefined ? { fields: request.fields } : {}),
      ...(request.interaction ? { interaction: request.interaction } : {}),
      source: "player",
    };
  });
  const answeredTurns = new Set(
    actions.flatMap((action) =>
      action.interaction ? [action.interaction.turnId] : [],
    ),
  );
  if (answeredTurns.size > 1)
    throw new ActionValidationError(
      "All interaction answers of one submission must answer the same turn",
      "invalid_action",
      400,
    );
  return actions;
}

/** The labels of the plugin kinds, for `renderActions`. */
export function pluginKindLabels(
  kinds: readonly ActionKindDescriptor[],
): Map<string, I18nText> {
  return new Map(
    kinds
      .filter((kind) => !isBaseActionKind(kind.kind))
      .map((kind) => [kind.kind, kind.display.label]),
  );
}

/** An action as a client would resend it: everything but `source`. */
export function actionRequestOf(action: TurnAction): TurnActionRequest {
  const { source: _source, ...request } = action;
  return request;
}

const MAX_STORED_FIELDS_BYTES = 4 * 1024;

/**
 * The actions as the player's chat row keeps them: `fields` over 4 KB are
 * left out, so a large form answer does not bloat every message read.
 */
export function storedActions(actions: readonly TurnAction[]): TurnAction[] {
  return actions.map((action) => {
    if (action.fields === undefined) return action;
    const bytes = new TextEncoder().encode(
      JSON.stringify(action.fields),
    ).byteLength;
    if (bytes <= MAX_STORED_FIELDS_BYTES) return action;
    const { fields: _fields, ...rest } = action;
    return rest;
  });
}
