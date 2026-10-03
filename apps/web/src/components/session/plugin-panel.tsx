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
import { PluginSurfaceBoundary } from "@/components/error-boundary.js";
import {
  usePluginJobs,
  usePluginNamespaces,
  usePluginNamespace,
} from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import type { PluginRpcRequest } from "@/services/api.js";
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

export type PluginPanelStateCache = Map<string, StateStore>;

export interface PluginPanelProps {
  pluginId: string;
  panelId?: string;
  spec: Record<string, unknown>;
  stateCache?: PluginPanelStateCache;
  handlers?: Record<
    string,
    (params: Record<string, unknown>) => Promise<unknown> | unknown
  >;
  stateOverride?: Record<string, unknown>;
  interactionLocked?: boolean;
  surfaceContext?: Readonly<Record<string, unknown>>;
  enableDevtools?: boolean;
  /** The panel is shown in the large dialog, not the side column. */
  expanded?: boolean;
}

function resolveEmptyMessage(value: unknown, locale: string): string {
  return resolveDisplayText(value, locale).trim();
}

export function PluginPanel({
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
}: PluginPanelProps) {
  const interactionLockedRef = useRef(interactionLocked);
  interactionLockedRef.current = interactionLocked;
  const { t, i18n } = useTranslation();
  const activeLocale = i18n.resolvedLanguage ?? i18n.language;
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
  const { state: sessionState } = useSession();
  const sessionCharacters =
    sessionState.gameState.characters &&
    Array.isArray(sessionState.gameState.characters)
      ? Object.fromEntries(
          sessionState.gameState.characters.map((character, index) => {
            const value = character as Record<string, unknown>;
            const key =
              typeof value.id === "string" ? value.id : `character-${index}`;
            return [key, value];
          }),
        )
      : {};
  const frameworkData =
    sourceKind === "session.characters"
      ? sessionCharacters
      : namespace === "_jobs"
        ? Object.fromEntries(
            jobs.map((job) => [
              job.jobId,
              job.messageKey ? { ...job, message: t(job.messageKey) } : job,
            ]),
          )
        : liveData;
  const data = stateOverride ?? frameworkData;

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
  const stateStoreRef = useRef<StateStore | null>(null);
  if (!stateStoreRef.current) {
    const cached = stateCache?.get(stateCacheKey);
    stateStoreRef.current = cached ?? createStateStore({});
    if (!cached) stateCache?.set(stateCacheKey, stateStoreRef.current);
  }
  const stateStore = stateStoreRef.current;
  const [uiState, setUiState] = useState(
    () => stateStore.get("/uiState") ?? null,
  );
  const updateUiState = useCallback(
    (params: Record<string, unknown>) => {
      const snapshot = parsePluginUiState(params.value);
      stateStore.set("/uiState", snapshot);
      setUiState(snapshot);
      return { status: "ok" };
    },
    [stateStore],
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

  const sessionId = sessionState.session?.id;

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
        if (!sessionId) return;
        const runtimeId =
          typeof params.runtimeId === "string" ? params.runtimeId : undefined;
        if (!runtimeId) {
          console.warn("[PluginPanel] invokeRuntime requires params.runtimeId");
          return;
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
          return res;
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`runtime:${runtimeId}`, false);
        }
      },
      invokePluginAction: async (params: Record<string, unknown>) => {
        if (!sessionId) return;
        const action =
          typeof params.action === "string" ? params.action : undefined;
        if (!action) {
          console.warn(
            "[PluginPanel] invokePluginAction requires params.action",
          );
          return;
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
          return res;
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`action:${action}`, false);
        }
      },
      invokeCommand: async (params: Record<string, unknown>) => {
        if (!sessionId) return;
        const built = buildPluginCommandRequest(pluginId, params);
        if (!built.ok) {
          console.warn(`[PluginPanel] ${built.error}`);
          emitToast("error", built.error);
          return;
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
          if (!response) return;
          if (response.status !== "ok") return;

          const result =
            response.result && typeof response.result === "object"
              ? (response.result as Record<string, unknown>)
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
            return;
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
          return response;
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
          if (spec.webview) throw err;
        } finally {
          markInvoking(`command:${built.command}`, false);
        }
      },
    };
    handlers.emitEvent = async (params: Record<string, unknown>) => {
      if (!sessionId) return;
      const topic = typeof params.topic === "string" ? params.topic : "";
      if (!topic) {
        console.warn("[PluginPanel] emitEvent requires params.topic");
        return;
      }
      const data =
        params.data &&
        typeof params.data === "object" &&
        !Array.isArray(params.data)
          ? (params.data as Record<string, unknown>)
          : {};
      markInvoking(`event:${topic}`, true);
      try {
        return await postPluginRpcWithApproval({
          sessionId,
          request: { kind: "event", pluginId, topic, payload: data },
          pluginId,
          actionLabel: `event ${topic}`,
          confirm: requestConfirm,
          t,
        });
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

  if (spec.webview && typeof spec.webview === "object") {
    const webview = spec.webview as { html?: unknown; height?: number };
    if (typeof webview.html === "string") {
      const allowed = Object.fromEntries(
        [
          "invokeRuntime",
          "invokePluginAction",
          "invokeCommand",
          "emitEvent",
          ...Object.keys(explicitHandlers ?? {}),
        ]
          .filter((name) => typeof handlers[name] === "function")
          .map((name) => [name, handlers[name]!]),
      );
      allowed.setUiState = updateUiState;
      return (
        <PluginWebview
          title={resolveEmptyMessage(spec.label, activeLocale) || pluginId}
          html={webview.html}
          height={webview.height}
          expanded={expanded}
          locked={interactionLocked}
          handlers={allowed}
          state={{
            data,
            locale: activeLocale,
            locked: interactionLocked,
            context: surfaceContext ?? {},
            uiState,
          }}
        />
      );
    }
  }

  if (!flatSpec) {
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
        {t("plugin.invalidPanelSpec", "Invalid panel spec")}: {specLabel} —{" "}
        {reason}
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
      <div className="px-4 pt-6">
        <p className="text-xs text-muted-foreground italic leading-relaxed text-center wrap-break-word max-w-prose mx-auto">
          {emptyMsg}
        </p>
      </div>
    );
  }

  return (
    <div
      className={
        interactionLocked
          ? "pointer-events-none opacity-80 select-none"
          : undefined
      }
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
              <div key={job.jobId} className="leading-relaxed">
                <span className="font-mono text-[10px] opacity-80">
                  {compactJobId(job.jobId)}
                </span>
                {job.runtimeId ? (
                  <span className="opacity-80"> · {job.runtimeId}</span>
                ) : null}
                <span>: </span>
                <span>{job.error ?? job.abortReason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <PluginSurfaceBoundary
        surfaceLabel={resolveEmptyMessage(spec.label, activeLocale) || pluginId}
      >
        <JSONUIProvider
          registry={covelRegistry}
          store={stateStore}
          handlers={Object.fromEntries(
            Object.entries(handlers).map(([name, handler]) => [
              name,
              async (params: Record<string, unknown>) => {
                if (interactionLockedRef.current) return;
                await handler(params);
              },
            ]),
          )}
          directives={covelDirectives}
        >
          <Renderer spec={flatSpec} registry={covelRegistry} />
          {enableDevtools ? <PluginJsonRenderDevtools spec={flatSpec} /> : null}
        </JSONUIProvider>
      </PluginSurfaceBoundary>
    </div>
  );
}
