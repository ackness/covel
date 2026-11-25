import { z } from "zod";
import type { SessionProjection } from "./session-bridge.js";
import {
  sanitizePanelBridgeData,
  type PanelBridgeOutcome,
  type PluginBridgeHandler,
} from "./plugin-bridge.js";
/**
 * PluginPanel — renders a single plugin panel from a json-render spec.
 *
 * Wraps <JSONUIProvider> + <Renderer> with the covel component registry
 * and injects pluginData as initial state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  JSONUIProvider,
  Renderer,
  createStateStore,
  type StateStore,
} from "@json-render/react";
import { covelRegistry } from "@/lib/catalog.js";
import { useLiveActionHandlers } from "@/lib/json-render-handlers.js";
import { PluginSurfaceBoundary } from "@/components/error-boundary.js";
import {
  usePluginJobs,
  usePluginDataSessionId,
  usePluginNamespaces,
  usePluginNamespace,
} from "@/stores/plugin-data-store.js";
import { useSessionStructure } from "@/stores/session-store.js";
import type { PluginRpcRequest, PluginRpcResponse } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  emitPluginRpcRuntimeResponse,
  postPluginRpcWithApproval,
} from "./plugin-rpc-ui.js";
import { compactJobId } from "@/lib/job-ui.js";
import { pluginPanelViewToSpec } from "@/lib/plugin-panel-spec.js";
import {
  buildPluginPanelInitialState,
  syncPluginPanelState,
  parsePluginUiState,
  resolvePluginPanelSources,
} from "@/lib/plugin-panel-state.js";
import { Button as UIButton } from "@/components/ui/button.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { emitNavEvent } from "@/lib/nav-events.js";
import { buildPluginCommandRequest } from "@/lib/plugin-command.js";
import { covelDirectives } from "@/lib/json-render-directives.js";
import { X } from "lucide-react";
import { PluginJsonRenderDevtools } from "./json-render-devtools.js";

import { PluginWebview } from "./plugin-webview.js";
import { pluginUiSpecIssues } from "@covel/shared";
import {
  PluginViewSessionContext,
  type PluginViewSession,
} from "./plugin-view-session-context.js";

export type PluginPanelStateCache = Map<string, StateStore>;

export interface PluginPanelProps {
  themeSessionId?: string;
  pluginId: string;
  panelId?: string;
  spec: Record<string, unknown>;
  stateCache?: PluginPanelStateCache;
  handlers?: Record<
    string,
    (params: Record<string, unknown>) => Promise<unknown> | unknown
  >;
  stateOverride?: Record<string, unknown>;
  sourcesOverride?: Record<string, Record<string, unknown>>;
  interactionLocked?: boolean;
  surfaceContext?: Readonly<Record<string, unknown>>;
  enableDevtools?: boolean;
  /** The panel is shown in the large dialog, not the side column. */
  expanded?: boolean;
  fill?: boolean;
  sessionBridge?: {
    projection: SessionProjection;
    handlers?: Readonly<Record<string, PluginBridgeHandler>>;
    isCurrent?: () => boolean;
  };
  /** Supplied only by the live declarative view host, never by a spec. */
  liveSession?: PluginViewSession;
  onRenderError?: () => void;
  onRetry?: () => void;
  onPageFailure?: () => void;
}

function resolveEmptyMessage(value: unknown, locale: string): string {
  return resolveDisplayText(value, locale).trim();
}

const webviewDraftMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  selectionGroup: z.string().trim().min(1).max(128).optional(),
});

const webviewStageDraftSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
});

/**
 * Defense-in-depth: even if an unvalidated spec reaches the client, never
 * inject raw session character data into a non-session-bridge webview.
 */
function isDisallowedWebviewSessionSource(
  spec: Readonly<Record<string, unknown>>,
): boolean {
  if (!spec.webview || spec.bridge === "session") return false;
  const source = (spec.dataSource as { source?: unknown } | undefined)?.source;
  return (
    source === "session.characters" || source === "session.characterSchema"
  );
}

function safePanelOutcomeData(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  try {
    return sanitizePanelBridgeData(value);
  } catch {
    return undefined;
  }
}

function panelRpcStatusOutcome(
  response: PluginRpcResponse | null | undefined,
): PanelBridgeOutcome | null {
  if (!response) return { ok: false, status: "unavailable" };
  if (response.status === "accepted") return { ok: true, status: "accepted" };
  if (response.status !== "ok") return { ok: false, status: "rejected" };
  return null;
}

function hasRpcFailure(
  response: Extract<PluginRpcResponse, { status: "ok" }>,
): boolean {
  return Boolean(
    response.abortReason ||
    response.runtimeResults?.some((item) => item.status === "failed"),
  );
}

function toPanelRuntimeRpcOutcome(
  response: PluginRpcResponse | null | undefined,
  pluginId: string,
  runtimeId: string,
): PanelBridgeOutcome {
  const nonOk = panelRpcStatusOutcome(response);
  if (nonOk) return nonOk;
  const okResponse = response as Extract<PluginRpcResponse, { status: "ok" }>;
  const target = okResponse.runtimeResults?.find(
    (item) => item.pluginId === pluginId && item.runtimeId === runtimeId,
  );
  if (
    hasRpcFailure(okResponse) ||
    target?.status === "failed" ||
    (typeof target?.error === "string" && target.error.length > 0)
  ) {
    return { ok: false, status: "failed" };
  }
  if (target?.status === "skipped") {
    return { ok: false, status: "skipped" };
  }
  const data = safePanelOutcomeData(target?.output);
  return {
    ok: true,
    status: "ok",
    ...(data !== undefined ? { data } : {}),
  };
}

function toPanelActionRpcOutcome(
  response: PluginRpcResponse | null | undefined,
): PanelBridgeOutcome {
  const nonOk = panelRpcStatusOutcome(response);
  if (nonOk) return nonOk;
  const okResponse = response as Extract<PluginRpcResponse, { status: "ok" }>;
  if (hasRpcFailure(okResponse)) return { ok: false, status: "failed" };
  const data = safePanelOutcomeData(okResponse.result);
  return {
    ok: true,
    status: "ok",
    ...(data !== undefined ? { data } : {}),
  };
}

function toPanelEventRpcOutcome(
  response: PluginRpcResponse | null | undefined,
): PanelBridgeOutcome {
  return panelRpcStatusOutcome(response) ?? { ok: true, status: "ok" };
}

const EMPTY_SOURCES: Record<string, Record<string, unknown>> = {};
const EMPTY_JOBS: ReturnType<typeof usePluginJobs> = [];

export function PluginPanel(props: PluginPanelProps) {
  if (props.spec.bridge === "session") return <SessionPluginPanel {...props} />;
  const live =
    props.liveSession &&
    props.fill &&
    !props.spec.webview &&
    props.stateOverride === undefined &&
    !props.enableDevtools;
  if (live && pluginUiSpecIssues(props.spec, props.pluginId, "view").length)
    throw new Error("Invalid live declarative view");
  return (
    <PluginViewSessionContext.Provider value={live ? props.liveSession! : null}>
      {props.stateOverride !== undefined ? (
        <SnapshotPluginPanel {...props} />
      ) : (
        <LivePluginPanel {...props} />
      )}
    </PluginViewSessionContext.Provider>
  );
}

/** Session pages have no access to the ordinary panel data or handler map. */
function SessionPluginPanel(props: PluginPanelProps) {
  const { i18n } = useTranslation();
  const webview = props.spec.webview as
    { html?: string; url?: string; height?: number } | undefined;
  const session = props.sessionBridge;
  const webviewState = useMemo(
    () => ({ locale: i18n.language, session: session?.projection }),
    [i18n.language, session?.projection],
  );
  if (!webview || !session) return null;
  return (
    <PluginWebview
      themeSessionId={props.themeSessionId}
      title={
        resolveEmptyMessage(props.spec.label, i18n.language) || props.pluginId
      }
      html={webview.html}
      src={webview.url}
      height={webview.height}
      expanded={props.expanded}
      fill={props.fill}
      onRetry={props.onRetry}
      onPageFailure={props.onPageFailure}
      sessionPage
      isCurrent={session.isCurrent}
      locked={false}
      handlers={session.handlers ?? {}}
      state={webviewState}
    />
  );
}

function SnapshotPluginPanel(props: PluginPanelProps) {
  const sessionId = usePluginDataSessionId() ?? undefined;
  return (
    <PluginPanelView
      {...props}
      data={props.stateOverride!}
      sources={props.sourcesOverride ?? EMPTY_SOURCES}
      jobs={EMPTY_JOBS}
      sessionId={sessionId}
    />
  );
}

const EMPTY_RECORD: Record<string, unknown> = {};

function LivePluginPanel(props: PluginPanelProps) {
  const { pluginId, spec } = props;
  const { t } = useTranslation();
  const dataSource = spec.dataSource as
    | { namespace?: string; source?: string; bindings?: Record<string, string> }
    | undefined;
  const namespace = dataSource?.namespace ?? "default";
  const sourceKind = dataSource?.source;
  const liveData = usePluginNamespace(pluginId, namespace);
  const ownerNamespaces = usePluginNamespaces(pluginId);
  const sources = useMemo(
    () =>
      resolvePluginPanelSources(ownerNamespaces, dataSource?.bindings ?? {}),
    [ownerNamespaces, dataSource?.bindings],
  );
  const jobs = usePluginJobs(pluginId);
  const sessionState = useSessionStructure();
  const rawCharacters = sessionState.gameState.characters;
  const sessionCharacters = useMemo(
    () =>
      rawCharacters && Array.isArray(rawCharacters)
        ? Object.fromEntries(
            rawCharacters.map((character, index) => {
              const value = character as Record<string, unknown>;
              const key =
                typeof value.id === "string" ? value.id : `character-${index}`;
              return [key, value];
            }),
          )
        : EMPTY_RECORD,
    [rawCharacters],
  );
  const schema = sessionState.gameState.characterSchema;
  const sessionCharacterSchema = useMemo(
    () =>
      schema && typeof schema === "object" && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)
        : EMPTY_RECORD,
    [schema],
  );
  const jobsData = useMemo(
    () =>
      namespace === "_jobs"
        ? Object.fromEntries(
            jobs.map((job) => [
              job.jobId,
              job.messageKey ? { ...job, message: t(job.messageKey) } : job,
            ]),
          )
        : EMPTY_RECORD,
    [namespace, jobs, t],
  );
  const frameworkData = isDisallowedWebviewSessionSource(spec)
    ? EMPTY_RECORD
    : sourceKind === "session.characters"
      ? sessionCharacters
      : sourceKind === "session.characterSchema"
        ? sessionCharacterSchema
        : namespace === "_jobs"
          ? jobsData
          : liveData;
  return (
    <PluginPanelView
      {...props}
      data={frameworkData}
      sources={sources}
      jobs={jobs}
      sessionId={sessionState.session?.id}
    />
  );
}

function PluginPanelView({
  pluginId,
  panelId,
  spec,
  stateCache,
  handlers: explicitHandlers,
  stateOverride,
  interactionLocked = false,
  surfaceContext,
  enableDevtools = false,
  expanded = false,
  fill = false,
  onRenderError,
  onRetry,
  onPageFailure,
  data,
  sources,
  jobs,
  sessionId,
}: PluginPanelProps & {
  data: Record<string, unknown>;
  sources: Record<string, Record<string, unknown>>;
  jobs: ReturnType<typeof usePluginJobs>;
  sessionId?: string;
}) {
  const { t, i18n } = useTranslation();
  const activeLocale = i18n.resolvedLanguage ?? i18n.language;
  const namespace =
    (spec.dataSource as { namespace?: string } | undefined)?.namespace ??
    "default";

  // Per-action in-flight tracking — surfaced to json-render state under
  // `/_invoking/<key>` so the catalog Button can show a loading spinner while
  // a plugin-rpc call is pending. Without this affordance the player clicks
  // "generate image" and stares at a static button for ~30 s while the LLM
  // chain runs, with no signal that anything is happening. External state
  // synchronization replaces the invoking map when calls start or finish.
  const [invokingMap, setInvokingMap] = useState<Record<string, true>>({});
  const [dismissedErrorJobs, setDismissedErrorJobs] = useState<
    Record<string, true>
  >({});
  const markInvoking = useCallback((key: string, on: boolean) => {
    setInvokingMap((prev) => {
      if (on) {
        if (prev[key]) return prev;
        return { ...prev, [key]: true };
      }
      if (!prev[key]) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const stateCacheKey = JSON.stringify([
    spec.webview ? "webview" : "json",
    pluginId,
    panelId ?? spec.id ?? spec.label ?? "panel",
  ]);
  const stateCacheKeyRef = useRef<string | null>(null);
  const stateStoreRef = useRef<StateStore | null>(null);
  if (stateCacheKeyRef.current !== stateCacheKey || !stateStoreRef.current) {
    stateCacheKeyRef.current = stateCacheKey;
    const cached = stateCache?.get(stateCacheKey);
    stateStoreRef.current = cached ?? createStateStore({});
    if (!cached) stateCache?.set(stateCacheKey, stateStoreRef.current);
  }
  const stateStore = stateStoreRef.current;
  const [uiState, setUiState] = useState(
    () => stateStore.get("/uiState") ?? null,
  );
  useEffect(() => {
    setUiState(stateStore.get("/uiState") ?? null);
  }, [stateStore]);
  const updateUiState = useCallback(
    (params: Record<string, unknown>) => {
      const snapshot = parsePluginUiState(params.value);
      stateStore.set("/uiState", snapshot);
      setUiState(snapshot);
      return { status: "ok" };
    },
    [stateStore],
  );

  const webviewData = isDisallowedWebviewSessionSource(spec)
    ? EMPTY_RECORD
    : data;
  const resolvedSurfaceContext = surfaceContext ?? EMPTY_RECORD;
  const webviewState = useMemo(
    () => ({
      data: webviewData,
      locale: activeLocale,
      locked: interactionLocked,
      context: resolvedSurfaceContext,
      uiState,
    }),
    [
      webviewData,
      activeLocale,
      interactionLocked,
      resolvedSurfaceContext,
      uiState,
    ],
  );

  const initialState = useMemo(
    () => buildPluginPanelInitialState(data, invokingMap, sources),
    [data, invokingMap, sources],
  );
  useEffect(() => {
    if (spec.webview) return;
    syncPluginPanelState(stateStore, initialState);
  }, [initialState, stateStore, spec.webview]);

  const failedJobs = useMemo(
    () =>
      jobs
        .filter(
          (job) =>
            job.status === "failed" &&
            (job.error || job.abortReason) &&
            !dismissedErrorJobs[job.jobId],
        )
        .slice(0, 3),
    [dismissedErrorJobs, jobs],
  );

  const flatSpec = useMemo(() => {
    try {
      if (spec.webview) return null;
      return pluginPanelViewToSpec(spec.view);
    } catch (e) {
      console.warn("[PluginPanel] Failed to convert spec:", e);
      return null;
    }
  }, [spec.view, spec.webview]);

  // Framework-provided default handlers wire plugin buttons to plugin-rpc.
  //
  //   invokeRuntime({ runtimeId, payload? })
  //     Fires one specific runtime via POST /api/sessions/:id/plugin-rpc.
  //     The current spec's pluginId is injected automatically, so spec
  //     authors only declare the runtime name.
  //
  //   invokePluginAction({ action, payload? })
  //     Plugin-declared `rpc` action handler (for custom server-side logic
  //     beyond runtime triggering).
  //
  //   invokeCommand({ command, args? })
  //     Runs a manifest-declared command through the same validation, context,
  //     approval, handler, and trace pipeline as composer `/commands`.
  //
  //   emitEvent({ topic, data? })
  //     Emits a domain event this plugin declares. The runtimes that subscribe
  //     to the topic run as background jobs; the click only queues them.
  //
  // All forms emit a toast on error so the player never gets a silent
  // failure when their click went nowhere.
  //
  // When `postPluginRpc` returns `approval-required`, the panel
  // must guide the user through the approval flow instead of silently
  // dropping the click. Community-trust plugins (including every third-party
  // plugin under `~/.covel/plugins/`) hit this path on first click.
  const defaultHandlers = useMemo<
    Record<
      string,
      (params: Record<string, unknown>) => Promise<unknown> | unknown
    >
  >(() => {
    const handlers: Record<
      string,
      (params: Record<string, unknown>) => Promise<unknown> | unknown
    > = {
      invokeRuntime: async (params: Record<string, unknown>) => {
        if (!sessionId) return { ok: false, status: "unavailable" };
        const runtimeId =
          typeof params.runtimeId === "string" ? params.runtimeId : undefined;
        if (!runtimeId) {
          console.warn("[PluginPanel] invokeRuntime requires params.runtimeId");
          return { ok: false, status: "unavailable" };
        }
        const req: PluginRpcRequest = {
          kind: "runtime",
          pluginId,
          runtimeId,
          payload: params.payload as unknown,
          ...(params.expectsBackgroundFollower === true
            ? { expectsBackgroundFollower: true }
            : {}),
        };
        markInvoking(`runtime:${runtimeId}`, true);
        try {
          const res = await postPluginRpcWithApproval({
            sessionId,
            request: req,
            pluginId,
            actionLabel: `runtime ${runtimeId}`,
            confirm: requestConfirm,
            t,
          });
          if (res) {
            emitPluginRpcRuntimeResponse({
              response: res,
              t,
              runtimeId,
              expectsBackgroundFollower:
                params.expectsBackgroundFollower === true,
            });
          }
          return toPanelRuntimeRpcOutcome(res, pluginId, runtimeId);
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`runtime:${runtimeId}`, false);
        }
      },
      invokePluginAction: async (params: Record<string, unknown>) => {
        if (!sessionId) return { ok: false, status: "unavailable" };
        const action =
          typeof params.action === "string" ? params.action : undefined;
        if (!action) {
          console.warn(
            "[PluginPanel] invokePluginAction requires params.action",
          );
          return { ok: false, status: "unavailable" };
        }
        const req: PluginRpcRequest = {
          kind: "action",
          pluginId,
          action,
          payload: params.payload as unknown,
        };
        markInvoking(`action:${action}`, true);
        try {
          const res = await postPluginRpcWithApproval({
            sessionId,
            request: req,
            pluginId,
            actionLabel: `action ${action}`,
            confirm: requestConfirm,
            t,
          });
          if (res) {
            emitPluginRpcRuntimeResponse({
              response: res,
              t,
              runtimeId: action,
            });
          }
          return toPanelActionRpcOutcome(res);
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`action:${action}`, false);
        }
      },
      invokeCommand: async (params: Record<string, unknown>) => {
        if (!sessionId) return { ok: false, status: "unavailable" };
        const built = buildPluginCommandRequest(pluginId, params);
        if (!built.ok) {
          console.warn(`[PluginPanel] ${built.error}`);
          emitToast("error", built.error);
          return { ok: false, status: "unavailable" };
        }
        markInvoking(`command:${built.command}`, true);
        try {
          const response = await postPluginRpcWithApproval({
            sessionId,
            request: built.request,
            pluginId,
            actionLabel: `/${built.command}`,
            confirm: requestConfirm,
            t,
          });
          const nonOk = panelRpcStatusOutcome(response);
          if (nonOk) return nonOk;
          const okResponse = response as Extract<
            PluginRpcResponse,
            { status: "ok" }
          >;
          if (hasRpcFailure(okResponse)) {
            return { ok: false, status: "failed" };
          }

          const result =
            okResponse.result &&
            typeof okResponse.result === "object" &&
            !Array.isArray(okResponse.result)
              ? (okResponse.result as Record<string, unknown>)
              : undefined;
          const message = resolveDisplayText(
            result?.message ?? result?.reason,
            i18n.language,
          );
          if (result?.ok === false) {
            emitToast(
              "error",
              message ||
                t("session.commandFailed", { defaultValue: "Command failed." }),
            );
            return { ok: false, status: "failed" };
          }
          if (message) emitToast("info", message);

          const clientAction = result?.clientAction;
          if (
            clientAction &&
            typeof clientAction === "object" &&
            !Array.isArray(clientAction)
          ) {
            const action = clientAction as Record<string, unknown>;
            if (
              action.type === "open-plugin-panel" &&
              typeof action.panelId === "string"
            ) {
              emitNavEvent({
                type: "open-plugin-panel",
                pluginId,
                panelId: action.panelId,
              });
            }
          }
          const publicResult = result
            ? Object.fromEntries(
                Object.entries(result).filter(
                  ([key]) => key !== "clientAction",
                ),
              )
            : okResponse.result;
          const sanitizedData = safePanelOutcomeData(publicResult);
          return {
            ok: true,
            status: "ok",
            ...(sanitizedData !== undefined ? { data: sanitizedData } : {}),
          };
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`command:${built.command}`, false);
        }
      },
    };
    handlers.emitEvent = async (params: Record<string, unknown>) => {
      if (!sessionId) return { ok: false, status: "unavailable" };
      const topic = typeof params.topic === "string" ? params.topic : "";
      if (!topic) {
        console.warn("[PluginPanel] emitEvent requires params.topic");
        return { ok: false, status: "unavailable" };
      }
      const data =
        params.data &&
        typeof params.data === "object" &&
        !Array.isArray(params.data)
          ? (params.data as Record<string, unknown>)
          : {};
      markInvoking(`event:${topic}`, true);
      try {
        const res = await postPluginRpcWithApproval({
          sessionId,
          request: { kind: "event", pluginId, topic, payload: data },
          pluginId,
          actionLabel: `event ${topic}`,
          confirm: requestConfirm,
          t,
        });
        return toPanelEventRpcOutcome(res);
      } catch (err) {
        emitToast("error", err instanceof Error ? err.message : String(err));
        if (spec.webview) throw err;
      } finally {
        markInvoking(`event:${topic}`, false);
      }
    };
    return handlers;
  }, [i18n.language, pluginId, sessionId, markInvoking, t, spec.webview]);

  const handlers = explicitHandlers
    ? { ...defaultHandlers, ...explicitHandlers }
    : defaultHandlers;
  // A locked interaction does nothing; the lock and the handlers stay current.
  const actionHandlers = useLiveActionHandlers(
    Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        async (params: Record<string, unknown>) => {
          if (interactionLocked) return;
          await handler(params);
        },
      ]),
    ),
  );

  if (spec.webview && typeof spec.webview === "object") {
    const webview = spec.webview as {
      html?: unknown;
      url?: unknown;
      height?: number;
    };
    if (typeof webview.html === "string" || typeof webview.url === "string") {
      // Non-session webviews receive only framework RPC handlers, local UI
      // state, and documented surface-scoped draft handlers — never arbitrary
      // explicitHandlers or direct turn-sending message-block actions.
      const allowed: Record<string, PluginBridgeHandler> = {
        invokeRuntime: defaultHandlers.invokeRuntime!,
        invokePluginAction: defaultHandlers.invokePluginAction!,
        invokeCommand: defaultHandlers.invokeCommand!,
        emitEvent: defaultHandlers.emitEvent!,
        setUiState: updateUiState,
      };
      const isStageSurface = surfaceContext?.surface === "stage";
      if (stateOverride === undefined) {
        const draftHandler = !isStageSurface
          ? explicitHandlers?.draftMessage
          : undefined;
        if (typeof draftHandler === "function") {
          allowed.draftMessage = async (params: Record<string, unknown>) => {
            const parsed = webviewDraftMessageSchema.safeParse(params);
            if (!parsed.success) {
              throw new Error("Invalid draftMessage params");
            }
            await draftHandler(parsed.data);
            return { status: "ok" };
          };
        }
        const stageDraftHandler = isStageSurface
          ? explicitHandlers?.sendMessage
          : undefined;
        if (typeof stageDraftHandler === "function") {
          allowed.sendMessage = async (params: Record<string, unknown>) => {
            const parsed = webviewStageDraftSchema.safeParse(params);
            if (!parsed.success) {
              throw new Error("Invalid sendMessage params");
            }
            await stageDraftHandler(parsed.data);
            return { status: "ok" };
          };
        }
      }
      return (
        <PluginWebview
          themeSessionId={sessionId}
          title={resolveEmptyMessage(spec.label, activeLocale) || pluginId}
          html={typeof webview.html === "string" ? webview.html : undefined}
          src={typeof webview.url === "string" ? webview.url : undefined}
          onRetry={onRetry}
          onPageFailure={onPageFailure}
          height={webview.height}
          expanded={expanded}
          fill={fill}
          locked={interactionLocked}
          handlers={allowed}
          state={webviewState}
        />
      );
    }
  }

  if (!flatSpec) {
    if (fill) throw new Error("Plugin view could not be rendered");
    // Name the offending spec and the concrete reason instead of a generic
    // "Invalid panel spec". Server-side Zod validation already drops most
    // malformed specs (see /api/ui-specs diagnostics); this client-side path
    // only fires for specs that passed the envelope check but whose `view`
    // still cannot be converted to a json-render tree.
    const specLabel =
      resolveEmptyMessage(spec.label, activeLocale) ||
      (typeof spec.id === "string" ? spec.id : pluginId);
    const view = spec.view;
    // Sibling namespace, not `plugin.invalidPanelSpec.*`: that key is already a
    // string, and i18next cannot resolve a key that is both a leaf and a
    // parent — which is why these three silently fell back to English.
    const reason =
      view === undefined || view === null
        ? t("plugin.invalidPanelSpecReason.missingView", "missing `view`")
        : typeof view !== "object" || Array.isArray(view)
          ? t(
              "plugin.invalidPanelSpecReason.badView",
              "`view` must be an object",
            )
          : t(
              "plugin.invalidPanelSpecReason.conversionFailed",
              "could not render `view`",
            );
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("plugin.invalidPanelSpecDetail", { label: specLabel, reason })}
      </p>
    );
  }

  // Components that consume kernel data opt into rendering before plugin records exist.
  const alwaysRender = spec.alwaysRender === true;
  const isEmpty = !alwaysRender && Object.keys(data).length === 0;
  if (isEmpty) {
    const emptySpec = spec.emptyState as Record<string, unknown> | undefined;
    const customMsg = resolveEmptyMessage(emptySpec?.message, activeLocale);
    const label = resolveEmptyMessage(spec.label, activeLocale) || pluginId;
    const emptyMsg = customMsg || t("plugin.emptyPlaceholder", { label });
    return (
      <div className={fill ? "h-full overflow-y-auto px-4 pt-6" : "px-4 pt-6"}>
        <p className="text-xs text-muted-foreground italic leading-relaxed text-center wrap-break-word max-w-prose mx-auto">
          {emptyMsg}
        </p>
      </div>
    );
  }

  return (
    <div
      className={[
        fill ? "h-full overflow-y-auto" : "",
        interactionLocked ? "pointer-events-none opacity-80 select-none" : "",
      ].join(" ")}
      aria-disabled={interactionLocked}
      inert={interactionLocked}
    >
      {namespace !== "_jobs" && failedJobs.length > 0 && (
        <div className="mb-3 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">
              {t("plugin.runtimeErrors.title", {
                count: failedJobs.length,
                defaultValue: "Recent plugin error",
              })}
            </div>
            <UIButton
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-destructive hover:bg-destructive/10"
              aria-label={t(
                "plugin.runtimeErrors.dismiss",
                "Dismiss plugin error",
              )}
              onClick={() => {
                setDismissedErrorJobs((prev) => ({
                  ...prev,
                  ...Object.fromEntries(
                    failedJobs.map((job) => [job.jobId, true as const]),
                  ),
                }));
              }}
            >
              <X className="h-3 w-3" />
            </UIButton>
          </div>
          <div className="mt-1 space-y-1">
            {failedJobs.map((job) => (
              <details key={job.jobId} className="leading-relaxed">
                <summary className="cursor-pointer">
                  {t("plugin.runtimeErrors.summary", {
                    defaultValue:
                      "A background task of this plugin failed. Show details",
                  })}
                </summary>
                <div className="mt-1 wrap-break-word opacity-90">
                  <span className="font-mono text-[10px] opacity-80">
                    {compactJobId(job.jobId)}
                  </span>
                  {job.runtimeId ? (
                    <span className="opacity-80"> · {job.runtimeId}</span>
                  ) : null}
                  <span>: </span>
                  <span>{job.error ?? job.abortReason}</span>
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
      <PluginSurfaceBoundary
        onError={onRenderError}
        surfaceLabel={resolveEmptyMessage(spec.label, activeLocale) || pluginId}
      >
        <JSONUIProvider
          registry={covelRegistry}
          store={stateStore}
          handlers={actionHandlers}
          directives={covelDirectives}
        >
          <Renderer spec={flatSpec} registry={covelRegistry} />
          {enableDevtools ? <PluginJsonRenderDevtools spec={flatSpec} /> : null}
        </JSONUIProvider>
      </PluginSurfaceBoundary>
    </div>
  );
}
