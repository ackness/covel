import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginDiagnosticsSnapshot, PluginSummary } from "@covel/shared";
import {
  CAPABILITY_KEYS,
  type CapabilityCeiling,
  type CapabilityKey,
  type CapabilityPolicyMode,
  type CapabilityRisk,
  type PermissionsPolicyOverrides,
  type PluginGrantDecisions,
} from "@covel/shared/permissions";
import { Laptop, RefreshCw, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { isDesktopApp } from "@/lib/desktop-bridge.js";
import {
  getSessionApprovals,
  revokeSessionApprovals,
  type SessionApprovalsSnapshot,
} from "@/services/api/approvals.js";
import { isOperatorTokenRequired } from "@/services/api/health.js";
import {
  deletePluginGrants,
  getPermissionsSnapshot,
  listPermissionPlugins,
  setPluginGrants,
  updatePermissionsPolicy,
  type PermissionPluginSummary,
  type PermissionsSnapshot,
} from "@/services/api/permissions.js";
import { getPluginDiagnostics } from "@/services/api/plugin-diagnostics.js";
import { listInstalledPlugins } from "@/services/api/plugins.js";
import { ApiError } from "@/services/api/request.js";
import { getOperatorToken } from "@/services/session-credentials.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { PaneNotice, usePaneNotice } from "../pane-notice.js";
import { OperatorAccessPane } from "./OperatorAccessPane.js";
import { PermissionsPluginList, toI18nSlug } from "./PermissionsPluginList.js";
import { TrustedSourcesCard } from "./TrustedSourcesCard.js";

const RISK_ORDER: readonly CapabilityRisk[] = [
  "critical",
  "high",
  "medium",
  "low",
];

function summarizeCeilings(
  capabilities: Readonly<Record<CapabilityKey, CapabilityCeiling>>,
) {
  let enabled = 0;
  let operatorOnly = 0;
  let disabled = 0;
  for (const key of CAPABILITY_KEYS) {
    const ceiling = capabilities[key];
    if (ceiling === "enabled") enabled += 1;
    else if (ceiling === "operator-only") operatorOnly += 1;
    else disabled += 1;
  }
  return { enabled, operatorOnly, disabled };
}

export function PermissionsPane({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const sessionState = useContext(SessionStateContext);
  const activeSessionId = sessionId ?? sessionState?.session?.id;
  const desktop = isDesktopApp();
  const { notice, show } = usePaneNotice();

  const [snapshot, setSnapshot] = useState<PermissionsSnapshot | null>(null);
  const [plugins, setPlugins] = useState<PermissionPluginSummary[]>([]);
  const [pluginsAuthRequired, setPluginsAuthRequired] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([]);
  const [approvals, setApprovals] = useState<SessionApprovalsSnapshot | null>(
    null,
  );
  const [sessionDiagnostics, setSessionDiagnostics] =
    useState<PluginDiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [revokingSession, setRevokingSession] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const nextSnapshot = await getPermissionsSnapshot(signal);
        if (signal?.aborted) return;
        setSnapshot(nextSnapshot);

        const [pluginsResult, installedResult, approvalsResult, diagResult] =
          await Promise.all([
            listPermissionPlugins(signal)
              .then((items) => ({ status: "ok" as const, items }))
              .catch((err: unknown) => {
                if (err instanceof ApiError && err.status === 401) {
                  return { status: "unauthorized" as const };
                }
                return { status: "error" as const };
              }),
            listInstalledPlugins({ silentErrors: true }).catch(
              () => [] as PluginSummary[],
            ),
            activeSessionId
              ? getSessionApprovals(activeSessionId, signal).catch(() => null)
              : Promise.resolve(null),
            activeSessionId
              ? getPluginDiagnostics(activeSessionId, undefined, signal).catch(
                  () => null,
                )
              : Promise.resolve(null),
          ]);
        if (signal?.aborted) return;

        if (pluginsResult.status === "ok") {
          setPlugins(pluginsResult.items);
          setPluginsAuthRequired(false);
        } else if (pluginsResult.status === "unauthorized") {
          setPlugins([]);
          setPluginsAuthRequired(true);
        } else {
          setPlugins([]);
          setPluginsAuthRequired(false);
        }
        setInstalledPlugins(installedResult);
        setApprovals(approvalsResult);
        setSessionDiagnostics(diagResult);
      } catch (err) {
        if (signal?.aborted) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : t(
                "settings.permissions.loadFailed",
                "Failed to load permissions state.",
              ),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [activeSessionId, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadAll(controller.signal);
    return () => controller.abort();
  }, [loadAll, refreshNonce]);

  const ceilingCounts = useMemo(
    () => (snapshot ? summarizeCeilings(snapshot.capabilities) : null),
    [snapshot],
  );

  const groupedCapabilities = useMemo(() => {
    if (!snapshot) return [];
    return RISK_ORDER.map((risk) => ({
      risk,
      keys: CAPABILITY_KEYS.filter(
        (key) => snapshot.catalog[key].risk === risk,
      ),
    })).filter((group) => group.keys.length > 0);
  }, [snapshot]);

  const showOperatorAccess =
    snapshot?.deploymentForm !== "personal" ||
    isOperatorTokenRequired() !== false ||
    getOperatorToken() !== undefined;

  async function runMutation(
    setBusy: (busy: boolean) => void,
    action: () => Promise<void>,
    successMessage: string,
  ) {
    setBusy(true);
    try {
      await action();
      setRefreshNonce((n) => n + 1);
      show({ tone: "success", message: successMessage });
    } catch (err) {
      show({
        tone: "error",
        message: err instanceof Error ? err.message : t("settings.saveFailed"),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handlePolicyChange(
    key: CapabilityKey,
    nextMode: CapabilityPolicyMode,
  ) {
    if (!snapshot) return;
    await runMutation(
      setSavingPolicy,
      async () => {
        const nextOverrides: Record<string, CapabilityPolicyMode> = {
          ...snapshot.policy.overrides,
        };
        if (nextMode === snapshot.catalog[key].defaultPolicy) {
          delete nextOverrides[key];
        } else {
          nextOverrides[key] = nextMode;
        }
        const updated = await updatePermissionsPolicy(
          nextOverrides as PermissionsPolicyOverrides,
        );
        setSnapshot(updated);
      },
      t(
        "settings.permissions.policySaved",
        "Instance capability policy updated.",
      ),
    );
  }

  async function handleResetPolicy() {
    await runMutation(
      setSavingPolicy,
      async () => {
        const updated = await updatePermissionsPolicy(null);
        setSnapshot(updated);
      },
      t(
        "settings.permissions.policyResetDone",
        "Instance capability policy reset to defaults.",
      ),
    );
  }

  async function handleSavePluginGrants(
    pluginId: string,
    decisions: PluginGrantDecisions,
    expectedDigest?: string,
  ) {
    await runMutation(
      (busy) => setBusyPluginId(busy ? pluginId : null),
      async () => {
        const updated = await setPluginGrants(pluginId, {
          decisions,
          ...(expectedDigest ? { expectedDigest } : {}),
        });
        setPlugins((prev) =>
          prev.map((item) => (item.pluginId === pluginId ? updated : item)),
        );
      },
      t("settings.permissions.grantSaved", "Persistent plugin grants updated."),
    );
  }

  async function handleRevokePluginGrants(pluginId: string) {
    await runMutation(
      (busy) => setBusyPluginId(busy ? pluginId : null),
      async () => {
        await deletePluginGrants(pluginId);
      },
      t(
        "settings.permissions.grantRevoked",
        "Persistent plugin grants cleared.",
      ),
    );
  }

  async function handleRevokeSession(pluginId?: string) {
    if (!activeSessionId) return;
    await runMutation(
      setRevokingSession,
      async () => {
        await revokeSessionApprovals(activeSessionId, pluginId);
      },
      t(
        "settings.permissions.sessionGrantsRevoked",
        "Active session grants revoked.",
      ),
    );
  }

  if (loading && !snapshot) {
    return (
      <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
    );
  }

  if (loadError && !snapshot) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRefreshNonce((n) => n + 1)}
        >
          <RefreshCw className="mr-1.5 size-3.5" />
          {t("common.retry", "Retry")}
        </Button>
      </div>
    );
  }

  if (!snapshot) return null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PaneNotice notice={notice} />
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => setRefreshNonce((n) => n + 1)}
        >
          <RefreshCw className="mr-1.5 size-3.5" />
          {t("settings.permissions.refresh", "Refresh")}
        </Button>
      </div>

      <section className="space-y-2 rounded border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-primary" />
          <h3 className="settings-section-title">
            {t(
              "settings.permissions.deploymentSummaryTitle",
              "Host ceiling (L1)",
            )}
          </h3>
          <Badge variant="outline">
            {t(
              `settings.permissions.deploymentForm.${toI18nSlug(snapshot.deploymentForm)}`,
              snapshot.deploymentForm,
            )}
          </Badge>
          {desktop && (
            <Badge variant="secondary">
              {t("settings.permissions.desktopShellBadge", "Electron desktop")}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            "settings.permissions.deploymentSummaryDesc",
            "Host capability ceilings are resolved at server startup and cannot be widened by instance policies or per-plugin grants.",
          )}
        </p>
        {ceilingCounts && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="default">
              {t("settings.permissions.ceilingCountEnabled", {
                count: ceilingCounts.enabled,
                defaultValue: "Enabled: {{count}}",
              })}
            </Badge>
            <Badge variant="outline">
              {t("settings.permissions.ceilingCountOperator", {
                count: ceilingCounts.operatorOnly,
                defaultValue: "Operator-only: {{count}}",
              })}
            </Badge>
            <Badge variant="secondary">
              {t("settings.permissions.ceilingCountDisabled", {
                count: ceilingCounts.disabled,
                defaultValue: "Disabled: {{count}}",
              })}
            </Badge>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="settings-section-title">
              {t(
                "settings.permissions.policyTitle",
                "Instance capability policy",
              )}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                "settings.permissions.policyDescription",
                "Default capability rules applied across plugins below the host ceiling.",
              )}
            </p>
          </div>
          {Object.keys(snapshot.policy.overrides).length > 0 &&
            snapshot.policy.settable && (
              <Button
                size="sm"
                variant="outline"
                disabled={savingPolicy}
                onClick={() => void handleResetPolicy()}
              >
                {t(
                  "settings.permissions.resetPolicy",
                  "Reset policy to defaults",
                )}
              </Button>
            )}
        </div>

        {!snapshot.policy.settable && (
          <p className="rounded border border-border px-3 py-2 text-xs text-muted-foreground">
            {t(
              snapshot.policy.source === "env"
                ? "settings.serverSetting.fixedByDeployment"
                : "settings.serverSetting.operatorOnly",
            )}
          </p>
        )}

        <div className="space-y-4">
          {groupedCapabilities.map(({ risk, keys }) => (
            <div key={risk} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`settings.permissions.risk.${risk}`, risk)}
              </h4>
              <div className="divide-y divide-border rounded border border-border">
                {keys.map((key) => {
                  const def = snapshot.catalog[key];
                  const ceiling = snapshot.capabilities[key];
                  const state = snapshot.policy.effective[key];
                  const configuredMode =
                    snapshot.policy.overrides[key] ?? def.defaultPolicy;
                  const i18nKey = key.replaceAll(".", "_");
                  const disabled =
                    !snapshot.policy.settable ||
                    ceiling === "disabled" ||
                    savingPolicy;
                  const options: CapabilityPolicyMode[] = def.allowAutoPolicy
                    ? ["allow", "ask", "deny"]
                    : ["ask", "deny"];

                  return (
                    <div
                      key={key}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {t(
                              `settings.permissions.capabilityItems.${i18nKey}.label`,
                              key,
                            )}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {key}
                          </span>
                          <Badge
                            variant={
                              ceiling === "disabled" ? "secondary" : "outline"
                            }
                          >
                            {t(
                              `settings.permissions.ceiling.${toI18nSlug(ceiling)}`,
                              ceiling,
                            )}
                          </Badge>
                          <Badge
                            variant={
                              state.effective === "deny"
                                ? "destructive"
                                : "outline"
                            }
                          >
                            {t(
                              `settings.permissions.mode.${state.effective}`,
                              state.effective,
                            )}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t(
                            `settings.permissions.capabilityItems.${i18nKey}.description`,
                            key,
                          )}
                        </p>
                      </div>

                      <select
                        aria-label={t(
                          `settings.permissions.capabilityItems.${i18nKey}.label`,
                          key,
                        )}
                        value={configuredMode}
                        disabled={disabled}
                        onChange={(event) =>
                          void handlePolicyChange(
                            key,
                            event.target.value as CapabilityPolicyMode,
                          )
                        }
                        className="min-h-(--ui-control-touch) shrink-0 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 sm:min-h-(--ui-control-standard)"
                      >
                        {options.map((mode) => (
                          <option key={mode} value={mode}>
                            {t(`settings.permissions.mode.${mode}`, mode)}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <TrustedSourcesCard />
        {showOperatorAccess && <OperatorAccessPane />}
      </section>

      {pluginsAuthRequired ? (
        <section className="space-y-2 rounded border border-border p-3">
          <div className="flex items-center gap-2">
            <Shield className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="settings-section-title">
              {t("settings.permissions.pluginsTitle", "Per-plugin grants (L3)")}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "settings.permissions.pluginsOperatorRequired",
              "Enter an operator token above to inspect per-plugin capability audits and persistent grants on this host.",
            )}
          </p>
        </section>
      ) : (
        <PermissionsPluginList
          plugins={plugins}
          installedPlugins={installedPlugins}
          sessionDiagnostics={sessionDiagnostics}
          ceilings={snapshot.capabilities}
          busyPluginId={busyPluginId}
          onSaveGrants={handleSavePluginGrants}
          onRevokeGrants={handleRevokePluginGrants}
        />
      )}

      {activeSessionId && (
        <section className="space-y-3 rounded border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="settings-section-title">
                {t(
                  "settings.permissions.sessionGrantsTitle",
                  "Active session grants (L4)",
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("settings.permissions.sessionPendingCount", {
                  count: approvals?.items.length ?? 0,
                  defaultValue: "Pending prompts: {{count}}",
                })}
              </p>
            </div>
            {(approvals?.grants.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={revokingSession}
                onClick={() => void handleRevokeSession()}
              >
                <Trash2 className="mr-1.5 size-3.5" />
                {t(
                  "settings.permissions.revokeAllSessionGrants",
                  "Revoke all session grants",
                )}
              </Button>
            )}
          </div>

          {(approvals?.grants.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.permissions.noSessionGrants",
                "No cached grants are currently active in this session.",
              )}
            </p>
          ) : (
            <ul className="space-y-2">
              {approvals!.grants.map((grant) => (
                <li
                  key={`${grant.pluginId}:${grant.action}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5 text-xs"
                >
                  <div className="min-w-0 space-x-2">
                    <span className="font-mono font-medium">
                      {grant.pluginId}
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {grant.action}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revokingSession}
                    onClick={() => void handleRevokeSession(grant.pluginId)}
                  >
                    {t("settings.permissions.revokePlugin", "Revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {desktop && (
        <section className="space-y-2 rounded border border-border p-3">
          <div className="flex items-center gap-2">
            <Laptop className="size-4 shrink-0 text-primary" />
            <h3 className="settings-section-title">
              {t(
                "settings.permissions.desktopSecurityTitle",
                "Desktop shell security boundaries (read-only)",
              )}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(
              "settings.permissions.desktopSecurityDesc",
              "Enforced natively by the Electron main process:",
            )}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              {t(
                "settings.permissions.desktopRuleExternalNav",
                "External links open in the OS browser; the main window stays pinned to the local host.",
              )}
            </li>
            <li>
              {t(
                "settings.permissions.desktopRuleSubframeIpc",
                "Sandboxed plugin subframes cannot invoke privileged desktop IPC channels.",
              )}
            </li>
            <li>
              {t(
                "settings.permissions.desktopRuleClipboard",
                "Clipboard permissions stay restricted to explicit user actions.",
              )}
            </li>
            <li>
              {t(
                "settings.permissions.desktopRuleFileMode",
                "Local keys and managed secrets remain in 0600 files under the desktop config directory.",
              )}
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
