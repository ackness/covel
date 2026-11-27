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
import {
  Laptop,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { isDesktopApp } from "@/lib/desktop-bridge.js";
import { bumpPlatformInstanceDataVersion } from "@/lib/platform-ui-events.js";
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
import { SessionStructureContext } from "@/stores/session-store/context.js";
import { PaneNotice, usePaneNotice } from "../pane-notice.js";
import { OperatorAccessPane } from "./OperatorAccessPane.js";
import {
  PermissionsDiagnosticsSection,
  collectPluginDiagnostics,
} from "./PermissionsDiagnosticsSection.js";
import {
  PermissionsPluginList,
  getPluginPendingCapabilities,
  isGrantWarningStatus,
  toI18nSlug,
} from "./PermissionsPluginList.js";
import { TrustedSourcesCard } from "./TrustedSourcesCard.js";

const RISK_ORDER: readonly CapabilityRisk[] = [
  "critical",
  "high",
  "medium",
  "low",
];

const RISK_DOT_CLASS: Readonly<Record<CapabilityRisk, string>> = {
  critical: "bg-destructive",
  high: "bg-amber-500",
  medium: "bg-primary/70",
  low: "bg-muted-foreground/60",
};

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
  const sessionStructure = useContext(SessionStructureContext);
  const activeSessionId = sessionId ?? sessionStructure?.session?.id;
  const desktop = isDesktopApp();
  const { notice, show } = usePaneNotice();

  const [activeTab, setActiveTab] = useState<
    "plugins" | "policy" | "diagnostics"
  >("plugins");
  const [policyQuery, setPolicyQuery] = useState("");
  const [policyRiskFilter, setPolicyRiskFilter] = useState<
    CapabilityRisk | "all"
  >("all");

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

  const diagnostics = useMemo(
    () =>
      collectPluginDiagnostics(
        plugins,
        installedPlugins,
        sessionDiagnostics,
        t,
      ),
    [plugins, installedPlugins, sessionDiagnostics, t],
  );

  const errorDiagnosticCount = useMemo(
    () => diagnostics.filter((item) => item.severity === "error").length,
    [diagnostics],
  );

  const pluginsNeedingAttention = useMemo(() => {
    if (!snapshot) return 0;
    return plugins.filter(
      (plugin) =>
        isGrantWarningStatus(plugin.grantStatus) ||
        getPluginPendingCapabilities(plugin, snapshot.capabilities).length > 0,
    ).length;
  }, [plugins, snapshot]);

  const groupedCapabilities = useMemo(() => {
    if (!snapshot) return [];
    const normalized = policyQuery.trim().toLowerCase();
    return RISK_ORDER.filter(
      (risk) => policyRiskFilter === "all" || policyRiskFilter === risk,
    )
      .map((risk) => ({
        risk,
        keys: CAPABILITY_KEYS.filter((key) => {
          if (snapshot.catalog[key].risk !== risk) return false;
          if (!normalized) return true;
          const i18nKey = key.replaceAll(".", "_");
          const label = t(
            `settings.permissions.capabilityItems.${i18nKey}.label`,
            key,
          ).toLowerCase();
          const desc = t(
            `settings.permissions.capabilityItems.${i18nKey}.description`,
            "",
          ).toLowerCase();
          return (
            key.toLowerCase().includes(normalized) ||
            label.includes(normalized) ||
            desc.includes(normalized)
          );
        }),
      }))
      .filter((group) => group.keys.length > 0);
  }, [snapshot, policyQuery, policyRiskFilter, t]);

  const groupedSessionGrants = useMemo(() => {
    const byPlugin = new Map<string, string[]>();
    for (const grant of approvals?.grants ?? []) {
      const actions = byPlugin.get(grant.pluginId);
      if (actions) actions.push(grant.action);
      else byPlugin.set(grant.pluginId, [grant.action]);
    }
    return Array.from(byPlugin, ([pluginId, actions]) => ({
      pluginId,
      actions,
    }));
  }, [approvals]);

  const showOperatorAccess =
    snapshot?.deploymentForm !== "personal" ||
    isOperatorTokenRequired() !== false ||
    getOperatorToken() !== undefined;

  async function runMutation(
    setBusy: (busy: boolean) => void,
    action: () => Promise<void>,
    successMessage: string,
    refreshPlatformUi = false,
  ): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      if (refreshPlatformUi) {
        bumpPlatformInstanceDataVersion();
      }
      setRefreshNonce((n) => n + 1);
      show({ tone: "success", message: successMessage });
      return true;
    } catch (err) {
      show({
        tone: "error",
        message: err instanceof Error ? err.message : t("settings.saveFailed"),
      });
      return false;
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
      true,
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
      true,
    );
  }

  async function handleSavePluginGrants(
    pluginId: string,
    decisions: PluginGrantDecisions,
    expectedDigest?: string,
  ): Promise<boolean> {
    return runMutation(
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
      true,
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
      true,
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
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <ShieldCheck className="size-4 shrink-0 text-primary" />
          <span className="font-medium text-foreground">
            {t(
              `settings.permissions.deploymentForm.${toI18nSlug(snapshot.deploymentForm)}`,
              snapshot.deploymentForm,
            )}
          </span>
          {desktop && (
            <Badge variant="secondary">
              {t("settings.permissions.desktopShellBadge", "Electron desktop")}
            </Badge>
          )}
          {ceilingCounts && (
            <span className="text-muted-foreground">
              ·{" "}
              {t("settings.permissions.ceilingCountEnabled", {
                count: ceilingCounts.enabled,
                defaultValue: "Enabled: {{count}}",
              })}
              {ceilingCounts.operatorOnly > 0 &&
                ` · ${t("settings.permissions.ceilingCountOperator", {
                  count: ceilingCounts.operatorOnly,
                  defaultValue: "Operator-only: {{count}}",
                })}`}
              {ceilingCounts.disabled > 0 &&
                ` · ${t("settings.permissions.ceilingCountDisabled", {
                  count: ceilingCounts.disabled,
                  defaultValue: "Disabled: {{count}}",
                })}`}
            </span>
          )}
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs"
          disabled={loading}
          onClick={() => setRefreshNonce((n) => n + 1)}
        >
          <RefreshCw className="mr-1.5 size-3.5" />
          {t("settings.permissions.refresh", "Refresh")}
        </Button>
      </div>

      <PaneNotice notice={notice} />

      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          setActiveTab(value as "plugins" | "policy" | "diagnostics")
        }
      >
        <div className="ui-workspace-rule">
          <TabsList
            aria-label={t(
              "settings.permissions.tabsLabel",
              "Permissions sections",
            )}
            className="h-auto max-w-full justify-start gap-4 bg-transparent p-0"
          >
            <TabsTrigger
              value="plugins"
              className="ui-tab-item gap-1.5 px-3 whitespace-normal data-[state=active]:shadow-none"
            >
              <span>
                {t("settings.permissions.tabPlugins", "Plugin grants")}
              </span>
              {pluginsNeedingAttention > 0 && (
                <Badge
                  variant="outline"
                  className="h-4 border-amber-500/50 bg-amber-500/10 px-1.5 text-[10px] text-amber-600 tabular-nums dark:text-amber-400"
                >
                  {pluginsNeedingAttention}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="policy"
              className="ui-tab-item gap-1.5 px-3 whitespace-normal data-[state=active]:shadow-none"
            >
              <span>
                {t("settings.permissions.tabPolicy", "Policy & sources")}
              </span>
              {Object.keys(snapshot.policy.overrides).length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Object.keys(snapshot.policy.overrides).length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="diagnostics"
              className="ui-tab-item gap-1.5 px-3 whitespace-normal data-[state=active]:shadow-none"
            >
              <span>
                {t("settings.permissions.tabDiagnostics", "Diagnostics")}
              </span>
              <Badge
                variant={
                  errorDiagnosticCount > 0
                    ? "destructive"
                    : diagnostics.length > 0
                      ? "secondary"
                      : "outline"
                }
                className="h-4 px-1.5 text-[10px] tabular-nums"
              >
                {diagnostics.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="plugins" className="mt-5 space-y-6">
          {pluginsAuthRequired ? (
            <section className="space-y-2 rounded-lg border border-border bg-card/40 p-4">
              <div className="flex items-center gap-2">
                <Shield className="size-4 shrink-0 text-muted-foreground" />
                <h3 className="settings-section-title">
                  {t(
                    "settings.permissions.pluginsTitle",
                    "Per-plugin grants (L3)",
                  )}
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings.permissions.pluginsOperatorRequired",
                  "Enter an operator token in Policy & sources to inspect per-plugin capability audits and persistent grants on this host.",
                )}
              </p>
            </section>
          ) : (
            <PermissionsPluginList
              plugins={plugins}
              ceilings={snapshot.capabilities}
              busyPluginId={busyPluginId}
              onSaveGrants={handleSavePluginGrants}
              onRevokeGrants={handleRevokePluginGrants}
            />
          )}

          {activeSessionId && (
            <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
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

              {groupedSessionGrants.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.permissions.noSessionGrants",
                    "No cached grants are currently active in this session.",
                  )}
                </p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background/60">
                  {groupedSessionGrants.map(({ pluginId, actions }) => (
                    <li
                      key={pluginId}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-mono font-medium">
                          {pluginId}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {actions.join(", ")}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={revokingSession}
                        onClick={() => void handleRevokeSession(pluginId)}
                      >
                        {t("settings.permissions.revokePlugin", "Revoke")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </TabsContent>

        <TabsContent value="policy" className="mt-5 space-y-6">
          <TrustedSourcesCard />
          {showOperatorAccess && <OperatorAccessPane />}

          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
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
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t(
                  snapshot.policy.source === "env"
                    ? "settings.serverSetting.fixedByDeployment"
                    : "settings.serverSetting.operatorOnly",
                )}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary">
                <Search
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <input
                  type="search"
                  value={policyQuery}
                  onChange={(event) => setPolicyQuery(event.target.value)}
                  placeholder={t(
                    "settings.permissions.policySearchPlaceholder",
                    "Filter capabilities...",
                  )}
                  className="h-8 w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {policyQuery && (
                  <button
                    type="button"
                    onClick={() => setPolicyQuery("")}
                    aria-label={t("common.clear", "Clear")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", ...RISK_ORDER] as const).map((risk) => (
                  <button
                    key={risk}
                    type="button"
                    onClick={() => setPolicyRiskFilter(risk)}
                    aria-pressed={policyRiskFilter === risk}
                    className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                      policyRiskFilter === risk
                        ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {risk === "all"
                      ? t("settings.permissions.riskAll", "All risks")
                      : t(`settings.permissions.risk.${risk}`, risk)}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              {groupedCapabilities.map(({ risk, keys }) => (
                <div key={risk} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 rounded-full ${RISK_DOT_CLASS[risk]}`}
                    />
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t(`settings.permissions.risk.${risk}`, risk)}
                    </h4>
                  </div>
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card/30">
                    {keys.map((key) => {
                      const def = snapshot.catalog[key];
                      const ceiling = snapshot.capabilities[key];
                      const state = snapshot.policy.effective[key];
                      const configuredMode =
                        snapshot.policy.overrides[key] ?? def.defaultPolicy;
                      const isOverridden =
                        snapshot.policy.overrides[key] !== undefined;
                      const i18nKey = key.replaceAll(".", "_");
                      const reserved = def.reserved === true;
                      const disabled =
                        !snapshot.policy.settable ||
                        ceiling === "disabled" ||
                        reserved ||
                        savingPolicy;
                      const options: CapabilityPolicyMode[] =
                        def.allowAutoPolicy
                          ? ["allow", "ask", "deny"]
                          : ["ask", "deny"];

                      return (
                        <div
                          key={key}
                          className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {t(
                                  `settings.permissions.capabilityItems.${i18nKey}.label`,
                                  key,
                                )}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {key}
                              </span>
                              {reserved && (
                                <Badge variant="secondary">
                                  {t(
                                    "settings.permissions.reservedBadge",
                                    "Reserved",
                                  )}
                                </Badge>
                              )}
                              {ceiling !== "enabled" && (
                                <Badge variant="secondary">
                                  {t(
                                    `settings.permissions.ceiling.${toI18nSlug(ceiling)}`,
                                    ceiling,
                                  )}
                                </Badge>
                              )}
                              {isOverridden && (
                                <Badge variant="outline">
                                  {t(
                                    "settings.permissions.customOverrideBadge",
                                    "Custom",
                                  )}
                                </Badge>
                              )}
                              {state.effective === "deny" &&
                                configuredMode !== "deny" && (
                                  <Badge variant="destructive">
                                    {t("settings.permissions.mode.deny", "Deny")}
                                  </Badge>
                                )}
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
                            className="h-8 shrink-0 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
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
          </section>

          {desktop && (
            <section className="space-y-2 rounded-lg border border-border bg-card/40 p-4">
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
        </TabsContent>

        <TabsContent value="diagnostics" className="mt-5">
          <PermissionsDiagnosticsSection diagnostics={diagnostics} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
