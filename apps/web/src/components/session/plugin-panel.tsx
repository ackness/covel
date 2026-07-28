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
import {
  pluginPanelViewToSpec,
  specUsesComponent,
} from "@/lib/plugin-panel-spec.js";
import {
  buildPluginPanelInitialState,
  flattenStateForPluginPanel,
} from "@/lib/plugin-panel-state.js";
import { Button as UIButton } from "@/components/ui/button.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { X } from "lucide-react";

export type PluginPanelStateCache = Map<string, StateStore>;

export interface PluginPanelProps {
  pluginId: string;
  spec: Record<string, unknown>;
  stateCache?: PluginPanelStateCache;
  onAction?: (actionName: string, params?: Record<string, unknown>) => void;
  handlers?: Record<
    string,
    (params: Record<string, unknown>) => Promise<void> | void
  >;
  stateOverride?: Record<string, unknown>;
  interactionLocked?: boolean;
}

function resolveEmptyMessage(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : "";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, string>;
    const candidates = [
      obj["zh"],
      obj["zh-CN"],
      obj["en"],
      ...Object.values(obj),
    ];
    for (const candidate of candidates) {
      if (
        candidate &&
        typeof candidate === "string" &&
        candidate.trim() !== ""
      ) {
        return candidate;
      }
    }
    return "";
  }
  return String(value);
}

export function PluginPanel({
  pluginId,
  spec,
  stateCache,
  onAction,
  handlers: explicitHandlers,
  stateOverride,
  interactionLocked = false,
}: PluginPanelProps) {
  const { t } = useTranslation();
  const dataSource = spec.dataSource as Record<string, string> | undefined;
  const namespace = dataSource?.namespace ?? "default";
  const sourceKind = dataSource?.source;
  const liveData = usePluginNamespace(pluginId, namespace);
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
        ? Object.fromEntries(jobs.map((job) => [job.jobId, job]))
        : liveData;
  const data = stateOverride ?? frameworkData;

  // Per-action in-flight tracking — surfaced to json-render state under
  // `/_invoking/<key>` so the catalog Button can show a loading spinner while
  // a plugin-rpc call is pending. Without this affordance the player clicks
  // "generate image" and stares at a static button for ~30 s while the LLM
  // chain runs, with no signal that anything is happening. StateProvider does
  // a flat-pointer diff each time `initialState` changes (see @json-render/
  // react StateProvider) so flipping a key here propagates through.
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

  const stateCacheKey = `${pluginId}:${String(spec.id ?? spec.label ?? "panel")}`;
  const stateStoreRef = useRef<StateStore | null>(null);
  if (!stateStoreRef.current) {
    const cached = stateCache?.get(stateCacheKey);
    stateStoreRef.current = cached ?? createStateStore({});
    if (!cached) stateCache?.set(stateCacheKey, stateStoreRef.current);
  }
  const stateStore = stateStoreRef.current;

  const initialState = useMemo(
    () => buildPluginPanelInitialState(data, invokingMap),
    [data, invokingMap],
  );
  useEffect(() => {
    const updates = flattenStateForPluginPanel(initialState);
    stateStore.update(updates);
  }, [initialState, stateStore]);

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
      return pluginPanelViewToSpec(spec.view);
    } catch (e) {
      console.warn("[PluginPanel] Failed to convert spec:", e);
      return null;
    }
  }, [spec.view]);

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
  // Both forms emit a toast on error so the player never gets a silent
  // failure when their click went nowhere.
  //
  // When `postPluginRpc` returns `approval-required`, the panel
  // must guide the user through the approval flow instead of silently
  // dropping the click. Community-trust plugins (including every third-party
  // plugin under `~/.covel/plugins/`) hit this path on first click.
  const defaultHandlers = useMemo<
    Record<string, (params: Record<string, unknown>) => Promise<void> | void>
  >(() => {
    const handlers: Record<
      string,
      (params: Record<string, unknown>) => Promise<void> | void
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
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
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
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
        } finally {
          markInvoking(`action:${action}`, false);
        }
      },
    };
    if (onAction) {
      handlers.apiCall = async (params) => {
        onAction("apiCall", params);
      };
      handlers.emitEvent = async (params) => {
        onAction("emitEvent", params);
      };
    }
    return handlers;
  }, [pluginId, sessionId, onAction, markInvoking, t]);

  const handlers = explicitHandlers
    ? { ...defaultHandlers, ...explicitHandlers }
    : defaultHandlers;

  if (!flatSpec) {
    // Name the offending spec and the concrete reason instead of a generic
    // "Invalid panel spec". Server-side Zod validation already drops most
    // malformed specs (see /api/ui-specs diagnostics); this client-side path
    // only fires for specs that passed the envelope check but whose `view`
    // still cannot be converted to a json-render tree.
    const specLabel =
      resolveEmptyMessage(spec.label) ||
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

  // Empty state: namespace has no data yet.
  // Specs can opt out by setting `alwaysRender: true` when they render content
  // sourced from elsewhere (e.g. a framework-registered component reading from
  // session context instead of plugin_data). Framework-owned helper components
  // (`ImageGallery` / `ImageJobs`) also read directly from live stores, so they
  // must render even before their namespace has rows; otherwise a just-started
  // image job is hidden until a refresh/hydration path repaints the panel.
  const alwaysRender =
    spec.alwaysRender === true ||
    specUsesComponent(spec.view, "ImageGallery") ||
    specUsesComponent(spec.view, "ImageJobs") ||
    specUsesComponent(spec.view, "PortraitGallery");
  const isEmpty = !alwaysRender && Object.keys(data).length === 0;
  if (isEmpty) {
    const emptySpec = spec.emptyState as Record<string, unknown> | undefined;
    const customMsg = resolveEmptyMessage(emptySpec?.message);
    const label = resolveEmptyMessage(spec.label) || pluginId;
    const emptyMsg = customMsg || t("plugin.emptyPlaceholder", { label });
    return (
      <div className="px-4 pt-6">
        <p className="text-xs text-muted-foreground italic leading-relaxed text-center break-words [overflow-wrap:anywhere] max-w-prose mx-auto">
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
        surfaceLabel={resolveEmptyMessage(spec.label) || pluginId}
      >
        <JSONUIProvider
          registry={covelRegistry}
          store={stateStore}
          handlers={handlers}
        >
          <Renderer spec={flatSpec} registry={covelRegistry} />
        </JSONUIProvider>
      </PluginSurfaceBoundary>
    </div>
  );
}
