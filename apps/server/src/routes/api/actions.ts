/**
 * Actions route — SSE bridge between frontend action protocol and turn executor.
 *
 * Translates action requests (submit_actions, start_session, the retries)
 * into turn execution and streams results back as SSE events. The route
 * parses, authorizes and admits the request, then opens the stream; the
 * turns it runs are orchestrated by `./actions/run-request.ts` and the turn
 * phases next to it, which write through `./actions/action-stream.ts`.
 */

import { Hono } from "hono";
import { streamOwnedSSE } from "../../application-work.js";
import type { DataStore, MediaStore } from "@covel/store";
import type { PluginRegistry, LoadedRuntime } from "@covel/plugin-loader";
import type { LLMAdapter, ToolExecutor, HookPipeline } from "@covel/runtime";
import type { EventBus } from "@covel/events";
import {
  createInteractionSubmitter,
  interactionSubmissionPayload,
  InteractionSubmissionError,
  FormRejectedError,
  FormValidatorFailedError,
} from "@covel/runtime";
import {
  type RuntimeManifest,
  type TurnAction,
  validateActionRequest,
} from "@covel/shared";
import type { CompactorRunner } from "@covel/context";
import { errorBody, logRequestError } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { sessionEventBus } from "./session/session-events.js";
import { closeSseDelivery } from "./sse-delivery.js";
import { readPluginUserSettings } from "./plugin-user-settings.js";
import { registerActionRequest } from "./turn-control.js";
import { resolveSessionById } from "./session/session-guard.js";
import { preflightFormApprovals } from "./plugin-rpc/form-approvals.js";
import { ActionRejectedError } from "./actions/action-rejection.js";
import { createActionStream } from "./actions/action-stream.js";
import { preflightActionApprovals } from "./actions/approval-preflight.js";
import { assertRecoverableTurn } from "./actions/execution-recovery.js";
import {
  actionContext,
  assertInputUncommitted,
  playerTurnInput,
  resolveActionsFor,
  type ActionContext,
} from "./actions/player-input.js";
import { createRequestLedger } from "./actions/request-ledger.js";
import {
  failActionRequest,
  releaseActionRequest,
  runActionRequest,
} from "./actions/run-request.js";
import { ActionValidationError } from "./actions/submit-actions.js";
import {
  createTurnHost,
  type ActionTurnRequest,
} from "./actions/turn-request.js";

// SSE uses CovelEventType names directly.
// Frontend handleSseEvent handles these standard types.

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
    llmAdapter: LLMAdapter;
    loadRuntimeFn: (
      manifest: RuntimeManifest,
      locale?: string,
      sessionId?: string,
    ) => Promise<LoadedRuntime | undefined>;
    toolExecutor: ToolExecutor;
    resolveModel: (
      manifest: RuntimeManifest,
      apiOverride?: string,
    ) => string | undefined;
    eventBus: EventBus;
    compactorRunner: CompactorRunner;
    mediaStore?: MediaStore;
    hookPipeline?: HookPipeline;
    ensureEmbeddingLock?: (sessionId: string) => Promise<void>;
  };
};

export const actionRoutes = new Hono<Env>();

actionRoutes.post("/", rateLimiter({ max: 30 }), async (c) => {
  const store = c.get("store");
  const pluginRegistry = c.get("pluginRegistry");
  const rootEventBus = c.get("eventBus");
  const mediaStore = c.get("mediaStore");
  const prepareToolsForSession = c.get("prepareToolsForSession"); // optional — see env.d.ts

  const rawBody = await c.req.json<unknown>().catch(() => null);
  const bodyResult = validateActionRequest(rawBody);
  if (!bodyResult.ok) {
    return c.json(
      errorBody(bodyResult.error, { code: "invalid_action_request" }),
      400,
    );
  }
  const body = bodyResult.value;
  const { requestId, type, sessionId, payload } = body;
  const isRuntimeRetry =
    type === "retry_runtime" || type === "retry_failed_runtimes";

  // Enforce header transport limits before opening the SSE response or doing
  // any session work. Malformed values remain a no-settings request.
  const decodedUserSettings = readPluginUserSettings(c);
  if (!decodedUserSettings.ok) return decodedUserSettings.response;

  const guard = await resolveSessionById(c, sessionId);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  // Fast path: a paused/ended session takes no actions. The authoritative
  // re-check happens under the session lock, in the turn preparation (this
  // read is racy), but rejecting here returns a clean 409 before the SSE
  // stream opens.
  if (session.status !== "active") {
    return c.json(
      errorBody(
        `session is ${session.status}; it must be active to accept actions`,
        { code: "session_not_active" },
      ),
      409,
    );
  }

  // The actions are checked here, for a status the client can read, and
  // again under the lock against the live session.
  let interactionPayload: ReturnType<typeof interactionSubmissionPayload>;
  let admissionContext: ActionContext | undefined;
  let admissionActions: readonly TurnAction[] | undefined;
  if (type === "submit_actions") {
    try {
      admissionContext = await actionContext(store, pluginRegistry, session);
      admissionActions = await resolveActionsFor(
        store,
        admissionContext,
        session,
        payload.actions,
      );
      interactionPayload = interactionSubmissionPayload(admissionActions);
    } catch (error) {
      if (!(error instanceof ActionValidationError)) throw error;
      return c.json(
        errorBody(error.message, {
          code: error.code,
          ...(error.details !== undefined ? { details: error.details } : {}),
        }),
        error.status,
      );
    }
  }

  const eventBus = sessionEventBus(rootEventBus, session);
  const approval = await preflightActionApprovals(c, session, body);
  if (approval) return approval;
  // A form's validator is its provider's server code: ask for that grant
  // before the stream opens. The lock re-checks it against the live session.
  if (interactionPayload) {
    const formApproval = await preflightFormApprovals(
      c,
      session,
      interactionPayload,
    );
    if (formApproval) return formApproval;
  }

  const submitInteraction = createInteractionSubmitter(async (request) => {
    const validator = c
      .get("rpcRegistry")
      .getFormValidator(request.pluginId, request.name);
    if (!validator)
      throw new InteractionSubmissionError(
        "Form validator is unavailable; activate and approve its plugin first",
      );
    return validator(request);
  }, store);

  let admissionRejection: Record<string, unknown> | undefined;
  // Admission reads must finish before registration can revoke another
  // request's advancement. Revalidate under the lock before any writes.
  if (type === "submit_actions" && admissionContext && admissionActions) {
    try {
      await assertRecoverableTurn(store, sessionId, payload.recoverFromTurnId, {
        type,
        payload,
      });
      await assertInputUncommitted(store, sessionId, payload.inputMessageId);
      const submission = interactionPayload
        ? await submitInteraction(interactionPayload, {
            sessionId,
            locale: session.locale,
          })
        : undefined;
      await playerTurnInput(
        admissionContext,
        session,
        admissionActions,
        payload.inputMessageId ?? crypto.randomUUID(),
        submission,
      );
    } catch (error) {
      if (error instanceof FormValidatorFailedError)
        logRequestError(
          c,
          `[actions] form validator failed for ${sessionId}`,
          error.cause,
        );
      if (
        error instanceof ActionRejectedError ||
        error instanceof ActionValidationError ||
        error instanceof InteractionSubmissionError
      )
        admissionRejection = {
          message: error.message,
          code: error.code,
          ...(error instanceof FormRejectedError
            ? { details: { issues: error.issues } }
            : {}),
          ...(error instanceof ActionValidationError &&
          error.details !== undefined
            ? { details: error.details }
            : {}),
        };
      else throw error;
    }
  }

  // Lazy-lock the session's embedding model once per process boot.
  // No-op when the store has no vector capability or no embed slot is
  // configured. See apps/server/src/embedding-lock.ts for rationale.
  const ensureEmbeddingLock = c.get("ensureEmbeddingLock");
  if (ensureEmbeddingLock) {
    try {
      await ensureEmbeddingLock(sessionId);
    } catch (err) {
      // Don't fail the turn if the lock can't be established —
      // RAG plugins will simply receive an empty vector store.
      // eslint-disable-next-line no-console
      console.warn(
        `[actions] embedding lock failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const turnId = crypto.randomUUID();

  // The content locale is fixed when the session is created. A request cannot
  // change it: switching the UI language mid-session changes labels, not the
  // language the story is written in.
  const effectiveLocale = session.locale;

  // Reconcile the process-local registry from the persisted session snapshot.
  // This is needed after restart and also removes plugins disabled by another
  // request or server instance.
  //
  // A `start_session` with an empty plugin set used to activate EVERY
  // registered plugin and persist that — including community plugins the
  // player never chose and mutually-exclusive ones (both narrative engines at
  // once), which then ran for the life of the session. Session creation is
  // what picks the plugin set; an empty set here means the caller skipped that
  // step, so fail loudly instead of inventing one.
  const sessionPlugins = session.activePlugins as readonly string[] | undefined;
  if (
    type === "start_session" &&
    (!sessionPlugins || sessionPlugins.length === 0)
  ) {
    return c.json(
      errorBody(
        "Session has no active plugins. Create the session with an explicit " +
          "plugin set (or a world whose manifest seeds one) before starting it.",
        { code: "no_active_plugins" },
      ),
      400,
    );
  }
  return streamOwnedSSE(c, async (stream) => {
    const events = createActionStream({
      sink: stream,
      requestId,
      sessionId,
      turnId,
      eventBus,
    });

    if (admissionRejection) {
      // Keep the action stream's refusal shape for form issues and drafts,
      // without registering a request that can supersede accepted work.
      await events.write("error.occurred", admissionRejection);
      await events.flush();
      await closeSseDelivery(stream);
      return;
    }

    // Registered after admission, before waiting for execution, so a stop
    // reaches this request while it waits for the lock and between the turns it chains. Released in the
    // finally below so a crashed stream never leaves a stale target behind.
    const control = registerActionRequest(
      sessionId,
      turnId,
      requestId,
      type === "submit_actions",
    );
    const ledger = createRequestLedger({
      store,
      stream: events,
      control,
      eventBus,
      request: body,
    });
    const request: ActionTurnRequest = {
      store,
      pluginRegistry,
      eventBus,
      mediaStore,
      body,
      session,
      turnId,
      playerSettings: decodedUserSettings.settings,
      submitInteraction,
      locale: effectiveLocale,
      isRuntimeRetry,
      host: createTurnHost(c, {
        store,
        body,
        session,
        playerSettings: decodedUserSettings.settings,
        prepareToolsForSession,
      }),
    };
    try {
      await runActionRequest(request, events, ledger);
    } catch (err) {
      await failActionRequest(request, events, ledger, err);
    } finally {
      await releaseActionRequest(request, events, ledger);
      await events.flush();
      await closeSseDelivery(stream);
    }
  });
});
