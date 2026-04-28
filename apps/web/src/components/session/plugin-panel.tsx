/**
 * PluginPanel — renders a single plugin panel from a json-render spec.
 *
 * Wraps <JSONUIProvider> + <Renderer> with the covel component registry
 * and injects pluginData as initial state.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { usePluginJobs, usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useSession } from "@/stores/session-store.js";
import { postPluginRpc, resolveApproval } from "@/services/api.js";
import type { PluginRpcRequest, PluginRpcResponse } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button as UIButton } from "@/components/ui/button.js";
import { X } from "lucide-react";

export interface PluginPanelProps {
  pluginId: string;
  spec: Record<string, unknown>;
  onAction?: (actionName: string, params?: Record<string, unknown>) => void;
  handlers?: Record<string, (params: Record<string, unknown>) => Promise<void> | void>;
  stateOverride?: Record<string, unknown>;
  interactionLocked?: boolean;
}

/**
 * Convert our JSON spec format (uses "component" key) to json-render's
 * nested format (uses "type" key), then flatten to Spec.
 */
function convertToSpec(view: unknown): Spec | null {
  if (!view || typeof view !== "object") return null;
  try {
    const nested = rewriteComponentToType(view as Record<string, unknown>);
    return nestedToFlat(nested);
  } catch (e) {
    console.warn("[PluginPanel] Failed to convert spec:", e);
    return null;
  }
}

/** Recursively rename "component" → "type" to match json-render's expected format. */
function rewriteComponentToType(node: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "component") {
      result.type = value;
    } else if (key === "children" && Array.isArray(value)) {
      result.children = value.map((child) => {
        if (typeof child === "object" && child !== null) {
          return rewriteComponentToType(child as Record<string, unknown>);
        }
        return child;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getPluginRpcFailureMessage(res: PluginRpcResponse): string {
  if (res.status === "error") return res.error;
  if (res.status !== "ok") return "";
  const runtimeError = res.runtimeResults?.find(
    (r) => r.status === "failed" || (typeof r.error === "string" && r.error.length > 0),
  )?.error;
  if (runtimeError) return runtimeError;
  return res.abortReason ?? "";
}

function shortJobId(jobId: string): string {
  return jobId.length > 10 ? `${jobId.slice(0, 8)}…` : jobId;
}

function resolveEmptyMessage(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" ? trimmed : "";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, string>;
    const candidates = [obj["zh"], obj["zh-CN"], obj["en"], ...Object.values(obj)];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "string" && candidate.trim() !== "") {
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
  onAction,
  handlers: explicitHandlers,
  stateOverride,
  interactionLocked = false,
}: PluginPanelProps) {
  const { t } = useTranslation();
  const namespace = (spec.dataSource as Record<string, string> | undefined)?.namespace ?? "default";
  const liveData = usePluginNamespace(pluginId, namespace);
  const jobs = usePluginJobs(pluginId);
  const frameworkData = namespace === "_jobs"
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
  const [dismissedErrorJobs, setDismissedErrorJobs] = useState<Record<string, true>>({});
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

  // Custom confirm dialog state — replaces `window.confirm` so the approval
  // prompt is themed, localised, and non-blocking. The promise pattern mirrors
  // the native API the call site already used so the handler stays linear.
  interface ConfirmRequest {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
    readonly resolve: (value: boolean) => void;
  }
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmRequestRef = useRef<ConfirmRequest | null>(null);
  confirmRequestRef.current = confirmRequest;
  const confirmAsync = useCallback(
    (params: Omit<ConfirmRequest, "resolve">) =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest({ ...params, resolve });
      }),
    [],
  );
  const handleConfirmResult = useCallback((value: boolean) => {
    const current = confirmRequestRef.current;
    if (!current) return;
    current.resolve(value);
    setConfirmRequest(null);
  }, []);

  const initialState = useMemo(() => {
    const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
    return { ...expandIndexedState(data), entries, _invoking: invokingMap };
  }, [data, invokingMap]);

  const failedJobs = useMemo(
    () => jobs
      .filter((job) => job.status === "failed" && (job.error || job.abortReason) && !dismissedErrorJobs[job.jobId])
      .slice(0, 3),
    [dismissedErrorJobs, jobs],
  );

  const flatSpec = useMemo(() => convertToSpec(spec.view), [spec.view]);

  // `useSession` is safe here — PluginPanel only renders inside a loaded
  // SessionProvider (right panel / plugin-message block). When the panel
  // is hoisted into a non-session context in future, guard with a null check.
  const { state: sessionState } = useSession();
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
  // Audit F3: when `postPluginRpc` returns `approval-required`, the panel
  // must guide the user through the approval flow instead of silently
  // dropping the click. Community-trust plugins (including every third-party
  // plugin under `~/.covel/plugins/`) hit this path on first click.
  const defaultHandlers = useMemo<
    Record<string, (params: Record<string, unknown>) => Promise<void> | void>
  >(() => {
    function emitAcceptedJob(jobId: string): void {
      emitToast(
        "info",
        t("plugin.invokeRuntime.submitted", {
          count: 1,
          ids: jobId,
          defaultValue:
            "Submitted {{count}} background job(s): {{ids}}. Waiting for completion...",
        }),
      );
    }

    function emitDeferredJobs(
      jobs: readonly { readonly jobId?: string; readonly runtimeId?: string }[],
    ): void {
      const jobIds = jobs.map((j) => j.jobId).filter(Boolean) as string[];
      const idList = jobIds.slice(0, 3).join(", ") + (jobIds.length > 3 ? ` (+${jobIds.length - 3})` : "");
      emitToast(
        "info",
        t("plugin.invokeRuntime.submitted", {
          count: jobIds.length,
          ids: idList,
          defaultValue:
            "Submitted {{count}} background job(s): {{ids}}. Waiting for completion...",
        }),
      );
    }

    async function handleApprovalRequired(
      approvalId: string,
      humanLabel: string,
      retry: () => Promise<PluginRpcResponse>,
    ): Promise<void> {
      // Themed React dialog instead of the browser's native confirm prompt:
      // respects the active locale, doesn't block the JS thread, and matches
      // the rest of the panel chrome. `session` scope means subsequent clicks
      // during this session skip the prompt entirely.
      const proceed = await confirmAsync({
        title: t("plugin.approval.title", {
          defaultValue: "Authorize plugin action",
        }),
        message: t("plugin.approval.confirmMessage", {
          pluginId,
          action: humanLabel,
          defaultValue:
            "Plugin {{pluginId}} requests permission to run {{action}}. Authorize all matching calls for this session?",
        }),
        confirmLabel: t("plugin.approval.allow", {
          defaultValue: "Authorize",
        }),
        cancelLabel: t("plugin.approval.deny", {
          defaultValue: "Deny",
        }),
      });
      try {
        await resolveApproval(approvalId, proceed ? "allow" : "deny", "session");
      } catch (err) {
        emitToast(
          "error",
          t("plugin.approval.submitFailed", {
            error: err instanceof Error ? err.message : String(err),
            defaultValue: "Approval submission failed: {{error}}",
          }),
        );
        return;
      }
      if (!proceed) {
        emitToast(
          "info",
          t("plugin.approval.denied", {
            action: humanLabel,
            defaultValue: "Denied {{action}}",
          }),
        );
        return;
      }
      // Retry the original RPC now that the gate has a session-scoped grant.
      try {
        const next = await retry();
        if (next.status === "error") {
          emitToast("error", next.error);
        } else if (next.status === "approval-required") {
          // Shouldn't happen — the gate just cached the allow. Surface so we
          // notice if it ever does.
          emitToast(
            "error",
            t("plugin.approval.unexpectedRequired", {
              defaultValue:
                "Still got approval-required after grant — please check the approval backend",
              }),
          );
        } else if (next.status === "accepted") {
          emitAcceptedJob(next.jobId);
        } else if (next.status === "ok") {
          const failureMessage = getPluginRpcFailureMessage(next);
          if (failureMessage) {
            emitToast("error", failureMessage);
          } else if ((next.failedJobs ?? []).length > 0) {
            emitToast(
              "error",
              t("plugin.invokeRuntime.failedJobs", {
                count: next.failedJobs?.length ?? 0,
                defaultValue: "{{count}} background job(s) failed. Check the job panel for details.",
              }),
            );
          } else if ((next.deferredJobs ?? []).length > 0) {
            emitDeferredJobs(next.deferredJobs ?? []);
          }
        }
      } catch (err) {
        emitToast("error", err instanceof Error ? err.message : String(err));
      }
    }

    const handlers: Record<
      string,
      (params: Record<string, unknown>) => Promise<void> | void
    > = {
      invokeRuntime: async (params: Record<string, unknown>) => {
        if (!sessionId) return;
        const runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
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
          const res = await postPluginRpc(sessionId, req);
          if (res.status === "error") {
            emitToast("error", res.error);
          } else if (res.status === "approval-required") {
            await handleApprovalRequired(res.approvalId, `runtime ${runtimeId}`, () =>
              postPluginRpc(sessionId, req),
            );
          } else if (res.status === "ok") {
            const failureMessage = getPluginRpcFailureMessage(res);
            if (failureMessage) {
              emitToast("error", failureMessage);
              return;
            }
            if ((res.failedJobs ?? []).length > 0) {
              emitToast(
                "error",
                t("plugin.invokeRuntime.failedJobs", {
                  count: res.failedJobs?.length ?? 0,
                  defaultValue: "{{count}} background job(s) failed. Check the job panel for details.",
                }),
              );
              return;
            }
            // Audit P1-8: when a sync runtime declares an event-chain
            // contract (e.g. prompt-generator → image-generator) but the
            // LLM emitted no events[].topic that matches a follower, the
            // response carries `runtimeResults` but no `deferredJobs`.
            // Surface a warning so the player isn't left staring at a
            // panel that "did nothing" — common failure mode when the
            // model drops the JSON envelope.
            const expectsFollower = params.expectsBackgroundFollower === true;
            const deferred = res.deferredJobs ?? [];
            if (expectsFollower && deferred.length === 0) {
              emitToast(
                "error",
                t("plugin.invokeRuntime.noFollowerEvents", {
                  runtimeId,
                  defaultValue:
                    "{{runtimeId}} finished but emitted no background follower (missing matching events[]). Check that the model output a valid JSON envelope.",
                }),
              );
            } else if (deferred.length > 0) {
              // Background follower(s) queued — emit a submission toast with
              // the framework-assigned jobIds so the player knows their click
              // landed and which jobs to watch in the gallery / _jobs surface.
              // The terminal "completed" / "failed" toast is fired by the
              // generic _jobs status-transition listener in session-store.
              emitDeferredJobs(deferred);
            }
          } else if (res.status === "accepted") {
            emitAcceptedJob(res.jobId);
          }
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
        } finally {
          markInvoking(`runtime:${runtimeId}`, false);
        }
      },
      invokePluginAction: async (params: Record<string, unknown>) => {
        if (!sessionId) return;
        const action = typeof params.action === "string" ? params.action : undefined;
        if (!action) {
          console.warn("[PluginPanel] invokePluginAction requires params.action");
          return;
        }
        const req: PluginRpcRequest = {
          pluginId,
          action,
          payload: params.payload as unknown,
        };
        markInvoking(`action:${action}`, true);
        try {
          const res = await postPluginRpc(sessionId, req);
          if (res.status === "error") {
            emitToast("error", res.error);
          } else if (res.status === "approval-required") {
            await handleApprovalRequired(res.approvalId, `action ${action}`, () =>
              postPluginRpc(sessionId, req),
            );
          }
        } catch (err) {
          emitToast("error", err instanceof Error ? err.message : String(err));
        } finally {
          markInvoking(`action:${action}`, false);
        }
      },
    };
    if (onAction) {
      handlers.apiCall = async (params) => { onAction("apiCall", params); };
      handlers.emitEvent = async (params) => { onAction("emitEvent", params); };
    }
    return handlers;
  }, [pluginId, sessionId, onAction, markInvoking, confirmAsync, t]);

  const handlers = explicitHandlers
    ? { ...defaultHandlers, ...explicitHandlers }
    : defaultHandlers;

  if (!flatSpec) {
    return <p className="text-xs text-muted-foreground italic">Invalid panel spec</p>;
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
    specUsesComponent(spec.view, "ImageJobs");
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
    <div className={interactionLocked ? "pointer-events-none opacity-80 select-none" : undefined} aria-disabled={interactionLocked}>
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
              aria-label={t("plugin.runtimeErrors.dismiss", "Dismiss plugin error")}
              onClick={() => {
                setDismissedErrorJobs((prev) => ({
                  ...prev,
                  ...Object.fromEntries(failedJobs.map((job) => [job.jobId, true as const])),
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
                  {shortJobId(job.jobId)}
                </span>
                {job.runtimeId ? <span className="opacity-80"> · {job.runtimeId}</span> : null}
                <span>: </span>
                <span>{job.error ?? job.abortReason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <JSONUIProvider
        registry={covelRegistry}
        initialState={initialState}
        handlers={handlers}
      >
        <Renderer spec={flatSpec} registry={covelRegistry} />
      </JSONUIProvider>
      <Dialog
        open={confirmRequest !== null}
        onOpenChange={(open) => {
          if (!open) handleConfirmResult(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmRequest?.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line pt-1">
              {confirmRequest?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <UIButton
              variant="outline"
              size="sm"
              onClick={() => handleConfirmResult(false)}
            >
              {confirmRequest?.cancelLabel}
            </UIButton>
            <UIButton size="sm" onClick={() => handleConfirmResult(true)}>
              {confirmRequest?.confirmLabel}
            </UIButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function specUsesComponent(node: unknown, component: string): boolean {
  if (!node || typeof node !== "object") return false;
  const rec = node as Record<string, unknown>;
  if (rec.component === component || rec.type === component) return true;
  const children = rec.children;
  if (Array.isArray(children)) {
    return children.some((child) => specUsesComponent(child, component));
  }
  return false;
}

function expandIndexedState(data: Record<string, unknown>): Record<string, unknown> {
  const expanded: Record<string, unknown> = { ...data };

  for (const [key, value] of Object.entries(data)) {
    flattenIndexedValue(expanded, singularize(key), value);
  }

  return expanded;
}

function flattenIndexedValue(
  target: Record<string, unknown>,
  baseKey: string,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;

  value.forEach((item, index) => {
    const itemKey = `${baseKey}${index + 1}`;
    if (Array.isArray(item)) {
      item.forEach((entry, entryIndex) => {
        target[`${itemKey}${entryIndex + 1}`] = entry;
      });
      return;
    }

    if (item && typeof item === "object") {
      for (const [childKey, childValue] of Object.entries(item as Record<string, unknown>)) {
        const nestedKey = `${itemKey}${capitalize(childKey)}`;
        if (Array.isArray(childValue)) {
          flattenIndexedValue(target, nestedKey, childValue);
        } else if (childValue && typeof childValue === "object") {
          for (const [innerKey, innerValue] of Object.entries(childValue as Record<string, unknown>)) {
            target[`${nestedKey}${capitalize(innerKey)}`] = innerValue;
          }
        } else {
          target[nestedKey] = childValue;
        }
      }
      return;
    }

    target[itemKey] = item;
  });
}

function singularize(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
