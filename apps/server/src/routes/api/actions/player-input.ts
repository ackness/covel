/**
 * The player's input of a turn: the submitted actions checked against the
 * session, rendered for the model and the chat row. The route checks them
 * before the stream opens, and the turn preparation again under the lock.
 */

import { z } from "zod";
import { actionsContent, renderActions } from "@covel/context";
import {
  findCommittedInteraction,
  type PreparedInteractionSubmission,
} from "@covel/runtime";
import {
  MAX_PLAYER_MESSAGE_CHARS,
  interactionActionKind,
  turnActionSchema,
  type TurnAction,
  type TurnActionRequest,
} from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore, SessionRecord } from "@covel/store";
import { resolveSessionActionKinds } from "../session/action-kinds.js";
import { ActionRejectedError } from "./action-rejection.js";
import {
  checkAnsweredFields,
  interactionKey,
  pluginKindLabels,
  resolveSubmittedActions,
} from "./submit-actions.js";

/** What the session needs to check and render a player's actions. */
export async function actionContext(
  store: DataStore,
  registry: PluginRegistry,
  session: SessionRecord,
) {
  return {
    kinds: resolveSessionActionKinds(session.activePlugins, registry),
    characters: await store.listCharacters(session.id),
    seats: session.seats,
  };
}

export type ActionContext = Awaited<ReturnType<typeof actionContext>>;

/**
 * The action kinds the interactions answered by `requests` declare, read
 * from their committed messages, by `interactionKey`.
 */
async function declaredInteractionKinds(
  store: DataStore,
  sessionId: string,
  requests: readonly TurnActionRequest[],
): Promise<Map<string, string>> {
  const kinds = new Map<string, string>();
  const turnIds = new Set(
    requests.flatMap((request) =>
      request.interaction ? [request.interaction.turnId] : [],
    ),
  );
  for (const turnId of turnIds) {
    const messages = await store.listTurnMessages(sessionId, { turnId });
    for (const request of requests) {
      if (request.interaction?.turnId !== turnId) continue;
      const { interactionId } = request.interaction;
      const located = findCommittedInteraction(messages, turnId, interactionId);
      if (!located) continue;
      kinds.set(
        interactionKey(turnId, interactionId),
        interactionActionKind(
          located.interaction.type,
          located.interaction.actionKind,
        ),
      );
    }
  }
  return kinds;
}

/** The submitted actions checked against the session; throws `ActionValidationError`. */
export async function resolveActionsFor(
  store: DataStore,
  context: ActionContext,
  session: Pick<SessionRecord, "id">,
  requests: readonly TurnActionRequest[],
): Promise<TurnAction[]> {
  return resolveSubmittedActions({
    requests,
    ...context,
    interactionKinds: await declaredInteractionKinds(
      store,
      session.id,
      requests,
    ),
  });
}

/** The player's input of one turn, as the turn and its chat row take it. */
export interface PlayerTurnInput {
  readonly actions: readonly TurnAction[];
  /** The model-facing rendering: `TurnInput.playerMessage`. */
  readonly message: string;
  /**
   * The chat row's `content`: the raw texts, one per line, or the rendering
   * when no action carries text (a plugin kind taken by its fields alone).
   */
  readonly content: string;
  readonly messageId: string;
}

export async function assertInputUncommitted(
  store: DataStore,
  sessionId: string,
  inputMessageId?: string,
): Promise<void> {
  if (!inputMessageId) return;
  const saved = await store.getMessage(sessionId, inputMessageId);
  const savedTurnId =
    saved?.metadata && typeof saved.metadata === "object"
      ? (saved.metadata as { turnId?: unknown }).turnId
      : undefined;
  if (typeof savedTurnId === "string" && savedTurnId.length > 0)
    throw new ActionRejectedError(
      "This message was already sent and its turn is saved.",
      "input_already_committed",
    );
}

export async function playerTurnInput(
  { kinds, characters, seats }: ActionContext,
  session: SessionRecord,
  actions: readonly TurnAction[],
  messageId: string,
  submission?: PreparedInteractionSubmission,
): Promise<PlayerTurnInput> {
  // Validate the values the answer stores, including defaults and coercion,
  // and count its filled narrative together with the other submitted text.
  if (submission) {
    const texts = [...submission.texts];
    actions = actions.map((action) => {
      if (!action.interaction) return action;
      const stored = submission.results.find(
        (result) => result.interactionId === action.interaction?.interactionId,
      );
      return {
        ...action,
        text: texts.shift() ?? "",
        fields: (stored?.values ?? action.fields ?? {}) as TurnAction["fields"],
      };
    });
    checkAnsweredFields(actions, kinds);
  }
  if (
    actions.reduce((sum, action) => sum + (action.text?.length ?? 0), 0) >
    MAX_PLAYER_MESSAGE_CHARS
  )
    throw new ActionRejectedError(
      `submit_actions text must be at most ${MAX_PLAYER_MESSAGE_CHARS} characters in total, answers included`,
      "invalid_action",
    );
  const message = await renderActions(actions, {
    characters,
    seats,
    locale: session.locale,
    kindLabels: pluginKindLabels(kinds),
  });
  return {
    actions,
    message,
    content: actionsContent(actions) || message,
    messageId,
  };
}

/** The player input a turn recorded on `turn.started`, for `retry_turn`. */
const recordedPlayerInputSchema = z.object({
  actions: z.array(turnActionSchema).min(1),
  messageId: z.string().min(1),
});

export async function recordedPlayerInput(
  store: DataStore,
  sessionId: string,
  turnId: string,
): Promise<z.infer<typeof recordedPlayerInputSchema> | undefined> {
  const [started] = await store.queryTraceEvents(sessionId, {
    turnId,
    types: ["turn.started"],
    newestFirst: true,
    limit: 1,
  });
  const payload = started?.payload as { playerInput?: unknown } | undefined;
  const parsed = recordedPlayerInputSchema.safeParse(payload?.playerInput);
  return parsed.success ? parsed.data : undefined;
}
