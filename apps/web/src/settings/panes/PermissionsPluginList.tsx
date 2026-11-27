import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resolveI18nText } from "@covel/shared";
import {
  derivePluginRequestedCapabilities,
  pluginGrantDecisionFor,
  type CapabilityCeiling,
  type CapabilityKey,
  type PluginGrantDecisions,
} from "@covel/shared/permissions";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type { PermissionPluginSummary } from "@/services/api/permissions.js";
import { PluginCapabilitiesPreview } from "./PluginCapabilitiesPreview.js";

export interface PermissionsPluginListProps {
  readonly plugins: readonly PermissionPluginSummary[];
  readonly ceilings: Readonly<Record<CapabilityKey, CapabilityCeiling>>;
  readonly busyPluginId: string | null;
  readonly onSaveGrants: (
    pluginId: string,
    decisions: PluginGrantDecisions,
    expectedDigest?: string,
  ) => Promise<boolean>;
  readonly onRevokeGrants: (pluginId: string) => Promise<void>;
}

export function toI18nSlug(value: string): string {
  return value.replaceAll(".", "_").replaceAll("-", "_");
}

export function isGrantWarningStatus(
  status: PermissionPluginSummary["grantStatus"],
): boolean {
  return (
    status === "stale-digest" ||
    status === "capability-escalated" ||
    status === "unreadable"
  );
}

/**
 * Determine which declared capabilities of a community plugin are still
 * awaiting an explicit L3 grant (`effective === "ask"`).
 */
export function getPluginPendingCapabilities(
  plugin: PermissionPluginSummary,
  ceilings: Readonly<Record<CapabilityKey, CapabilityCeiling>>,
): readonly CapabilityKey[] {
  if (plugin.source !== "community") return [];
  const requested = derivePluginRequestedCapabilities({
    tier: plugin.tier,
    capabilities: plugin.capabilities,
    existingDecisions: plugin.grant?.decisions,
  });
  return requested.filter((key) => {
    const state = plugin.effectiveCapabilities[key];
    if (!state || state.effective !== "ask") return false;
    if (ceilings[key] === "disabled" || state.lockedBy === "policy") {
      return false;
    }
    const explicitDeny = plugin.grant?.decisions[key] === "deny";
    if (
      key === "plugin.communityCode" &&
      plugin.sourceAutoApproved &&
      !explicitDeny
    ) {
      return false;
    }
    return true;
  });
}

function baseDecisionsForMutation(
  plugin: PermissionPluginSummary,
): PluginGrantDecisions {
  if (!plugin.grant) return {};
  if (plugin.grantStatus === "valid") {
    return { ...plugin.grant.decisions };
  }
  // When an existing grant is stale or capability-escalated, preserve sticky
  // denials only so outdated allow decisions are never silently re-committed.
  const preserved: PluginGrantDecisions = {};
  for (const [key, value] of Object.entries(plugin.grant.decisions) as [
    CapabilityKey,
    "allow" | "deny",
  ][]) {
    if (value === "deny") preserved[key] = "deny";
  }
  return preserved;
}

function PluginGrantCard({
  plugin,
  ceilings,
  isBusy,
  confirmedDanger,
  onDangerChange,
  onSaveGrants,
  onRevokeGrants,
}: {
  readonly plugin: PermissionPluginSummary;
  readonly ceilings: Readonly<Record<CapabilityKey, CapabilityCeiling>>;
  readonly isBusy: boolean;
  readonly confirmedDanger: boolean;
  readonly onDangerChange: (pluginId: string, checked: boolean) => void;
  readonly onSaveGrants: PermissionsPluginListProps["onSaveGrants"];
  readonly onRevokeGrants: PermissionsPluginListProps["onRevokeGrants"];
}) {
  const { t, i18n } = useTranslation();
  const displayName =
    resolveI18nText(plugin.name, i18n.language) || plugin.pluginId;
  const isCommunity = plugin.source === "community";
  const requestedCapabilities = useMemo(
    () =>
      derivePluginRequestedCapabilities({
        tier: plugin.tier,
        capabilities: plugin.capabilities,
        existingDecisions: plugin.grant?.decisions,
      }),
    [plugin.tier, plugin.capabilities, plugin.grant?.decisions],
  );
  const pendingCapabilities = useMemo(
    () => getPluginPendingCapabilities(plugin, ceilings),
    [plugin, ceilings],
  );

  const codeDecision = plugin.grant?.decisions["plugin.communityCode"];
  const declarativeDecision = plugin.grant?.decisions["plugin.declarative"];
  const hasValidCodeAllow =
    plugin.grantStatus === "valid" && codeDecision === "allow";
  const codeDenied = codeDecision === "deny";
  const codeCeilingDisabled = ceilings["plugin.communityCode"] === "disabled";
  const codePolicyDenied =
    plugin.effectiveCapabilities["plugin.communityCode"]?.lockedBy === "policy";
  const declarativeCeilingDisabled =
    ceilings["plugin.declarative"] === "disabled";
  const grantWarning = isCommunity && isGrantWarningStatus(plugin.grantStatus);
  const integrityWarning =
    isCommunity &&
    (plugin.integrity === "modified" || plugin.integrity === "unreadable");

  const hasDeniedCapability = requestedCapabilities.some(
    (key) => plugin.effectiveCapabilities[key]?.effective === "deny",
  );
  const needsCodeGrant =
    isCommunity &&
    plugin.tier === 3 &&
    !hasValidCodeAllow &&
    !codeCeilingDisabled &&
    !codePolicyDenied;
  const extraPendingCapabilities = pendingCapabilities.filter(
    (key) => key !== "plugin.communityCode",
  );
  const batchApproveKeys: readonly CapabilityKey[] = useMemo(() => {
    const keys = new Set<CapabilityKey>(pendingCapabilities);
    if (needsCodeGrant) keys.add("plugin.communityCode");
    return requestedCapabilities.filter((key) => keys.has(key));
  }, [pendingCapabilities, needsCodeGrant, requestedCapabilities]);

  async function handleSingleCapabilityChange(
    key: CapabilityKey,
    nextValue: "allow" | "deny" | "unset",
  ) {
    const nextDecisions: PluginGrantDecisions =
      baseDecisionsForMutation(plugin);
    if (nextValue === "unset") {
      delete nextDecisions[key];
    } else {
      nextDecisions[key] = nextValue;
    }
    if (Object.keys(nextDecisions).length === 0) {
      if (plugin.grant !== null) {
        await onRevokeGrants(plugin.pluginId);
      }
      return;
    }
    const saved = await onSaveGrants(
      plugin.pluginId,
      nextDecisions,
      plugin.contentDigest ?? undefined,
    );
    if (saved && key === "plugin.communityCode" && nextValue === "allow") {
      onDangerChange(plugin.pluginId, false);
    }
  }

  async function handleApproveBatch(keys: readonly CapabilityKey[]) {
    if (keys.length === 0) return;
    const nextDecisions: PluginGrantDecisions =
      baseDecisionsForMutation(plugin);
    for (const key of keys) {
      nextDecisions[key] = "allow";
    }
    const saved = await onSaveGrants(
      plugin.pluginId,
      nextDecisions,
      plugin.contentDigest ?? undefined,
    );
    if (saved && keys.includes("plugin.communityCode")) {
      onDangerChange(plugin.pluginId, false);
    }
  }

  if (!isCommunity) {
    return (
      <article className="rounded-lg border border-border/80 bg-card/30 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-sm font-medium wrap-break-word">
              {displayName}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {plugin.pluginId}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              v{plugin.version}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">
              {t("settings.permissions.source.builtin", "Bundled")}
            </Badge>
            <Badge variant="outline">
              {t(
                `settings.permissions.tier.${plugin.tier}`,
                `Tier ${plugin.tier}`,
              )}
            </Badge>
          </div>
        </div>
        {plugin.capabilities && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t(
                "settings.permissions.viewCapabilities",
                "View declared capabilities",
              )}
            </summary>
            <div className="mt-2">
              <PluginCapabilitiesPreview
                preview={{
                  capabilities: plugin.capabilities,
                  trustedSource: false,
                }}
              />
            </div>
          </details>
        )}
      </article>
    );
  }

  const readinessBadge = (() => {
    if (grantWarning || integrityWarning) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="size-3" />
          {t(
            `settings.permissions.grantStatus.${toI18nSlug(plugin.grantStatus)}`,
            plugin.grantStatus,
          )}
        </Badge>
      );
    }
    if (pendingCapabilities.length > 0) {
      return (
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <Clock className="size-3" />
          {t("settings.permissions.statusPendingCapabilities", {
            count: pendingCapabilities.length,
            defaultValue: "Pending approval ({{count}})",
          })}
        </Badge>
      );
    }
    if (hasDeniedCapability) {
      return (
        <Badge variant="destructive" className="gap-1">
          <ShieldAlert className="size-3" />
          {t("settings.permissions.statusRestricted", "Restricted")}
        </Badge>
      );
    }
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle2 className="size-3" />
        {t("settings.permissions.statusReady", "Authorized")}
      </Badge>
    );
  })();

  const approveButtonLabel =
    extraPendingCapabilities.length === 0 &&
    batchApproveKeys.length === 1 &&
    batchApproveKeys[0] === "plugin.communityCode"
      ? t("settings.permissions.grantServerCode", "Grant server code")
      : t("settings.permissions.approveAllRequested", {
          count: batchApproveKeys.length,
          defaultValue: "Approve all requested ({{count}})",
        });

  return (
    <article className="space-y-3.5 rounded-lg border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h4 className="text-sm font-semibold wrap-break-word text-foreground">
              {displayName}
            </h4>
            <span className="font-mono text-xs text-muted-foreground">
              {plugin.pluginId}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              v{plugin.version}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="outline">
              {t(
                `settings.permissions.tier.${plugin.tier}`,
                `Tier ${plugin.tier}`,
              )}
            </Badge>
            <Badge variant="outline">
              {t(
                `settings.permissions.integrity.${toI18nSlug(plugin.integrity)}`,
                plugin.integrity,
              )}
            </Badge>
            {plugin.trustedSource && (
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck className="size-3 text-primary" />
                {t("settings.trustedSources.badge")}
              </Badge>
            )}
            {plugin.contentDigest && (
              <span
                title={plugin.contentDigest}
                className="font-mono text-[11px] text-muted-foreground"
              >
                #{plugin.contentDigest.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">{readinessBadge}</div>
      </div>

      {grantWarning && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              `settings.permissions.grantStatusDesc.${toI18nSlug(plugin.grantStatus)}`,
              "Stored allow grants were invalidated because this package changed or escalated capabilities.",
            )}
          </span>
        </div>
      )}

      {plugin.tier === 3 && !hasValidCodeAllow && (
        <div className="space-y-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-destructive">
            <ShieldAlert className="size-3.5 shrink-0" />
            <span>
              {t(
                "settings.permissions.dangerZoneTitle",
                "Danger zone · Unsandboxed host code",
              )}
            </span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            {t(
              "settings.permissions.dangerZoneWarning",
              "Community server-side JavaScript runs inside the host Node process with the process's own permissions.",
            )}
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmedDanger}
              disabled={isBusy || codeCeilingDisabled || !plugin.contentDigest}
              onChange={(event) =>
                onDangerChange(plugin.pluginId, event.target.checked)
              }
            />
            <span>
              {t(
                "settings.permissions.dangerZoneConfirm",
                "I understand this plugin executes unsandboxed code inside the host process.",
              )}
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              disabled={
                isBusy ||
                codeCeilingDisabled ||
                codePolicyDenied ||
                !plugin.contentDigest ||
                !confirmedDanger
              }
              onClick={() => void handleApproveBatch(batchApproveKeys)}
            >
              {approveButtonLabel}
            </Button>
          </div>
        </div>
      )}

      {hasValidCodeAllow && pendingCapabilities.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
          <div className="flex min-w-0 items-start gap-2">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-foreground leading-relaxed">
              {t("settings.permissions.pendingCapabilitiesCallout", {
                count: pendingCapabilities.length,
                defaultValue:
                  "{{count}} additional declared capability(ies) still need per-plugin approval before this plugin can fully activate.",
              })}
            </p>
          </div>
          <Button
            size="sm"
            disabled={isBusy || !plugin.contentDigest}
            onClick={() => void handleApproveBatch(pendingCapabilities)}
          >
            {t("settings.permissions.approveRemainingCapabilities", {
              count: pendingCapabilities.length,
              defaultValue: "Approve remaining ({{count}})",
            })}
          </Button>
        </div>
      )}

      {requestedCapabilities.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t(
                "settings.permissions.pluginCapabilitiesMatrixTitle",
                "Declared capability grants",
              )}
            </span>
          </div>
          <div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border bg-background/60">
            {requestedCapabilities.map((key) => {
              const i18nKey = key.replaceAll(".", "_");
              const state = plugin.effectiveCapabilities[key];
              const ceiling = ceilings[key];
              const effectiveGrant = pluginGrantDecisionFor(
                plugin.grantStatus,
                plugin.grant,
                key,
              );
              const trustedImplicitCode =
                key === "plugin.communityCode" &&
                plugin.sourceAutoApproved &&
                effectiveGrant !== "deny" &&
                state.effective === "ask";
              const lockedByCeilingOrPolicy =
                ceiling === "disabled" ||
                state.lockedBy === "ceiling" ||
                state.lockedBy === "policy";
              const allowNeedsDangerConfirm =
                key === "plugin.communityCode" &&
                plugin.tier === 3 &&
                !hasValidCodeAllow &&
                !confirmedDanger;
              const label = t(
                `settings.permissions.capabilityItems.${i18nKey}.label`,
                key,
              );

              const statusText = trustedImplicitCode
                ? t(
                    "settings.permissions.effectiveTrustedAuto",
                    "Trusted source",
                  )
                : state.effective === "allow"
                  ? t("settings.permissions.mode.allow", "Allow")
                  : state.effective === "deny"
                    ? t("settings.permissions.mode.deny", "Deny")
                    : t("settings.permissions.statusNeedsApproval", "Pending");

              const statusTone =
                state.effective === "allow" || trustedImplicitCode
                  ? "text-primary"
                  : state.effective === "deny"
                    ? "text-destructive"
                    : "text-amber-600 dark:text-amber-400";

              return (
                <div
                  key={key}
                  className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">
                        {label}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {key}
                      </span>
                      <span className={`font-medium ${statusTone}`}>
                        · {statusText}
                      </span>
                    </div>
                  </div>

                  <select
                    aria-label={`${displayName} · ${label}`}
                    value={effectiveGrant}
                    disabled={
                      isBusy || !plugin.contentDigest || lockedByCeilingOrPolicy
                    }
                    onChange={(event) =>
                      void handleSingleCapabilityChange(
                        key,
                        event.target.value as "allow" | "deny" | "unset",
                      )
                    }
                    className="h-8 shrink-0 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 sm:w-40"
                  >
                    <option value="unset">
                      {t("settings.permissions.grantFollowPolicy", {
                        mode: t(
                          `settings.permissions.mode.${state.policy}`,
                          state.policy,
                        ),
                        defaultValue: "Follow policy ({{mode}})",
                      })}
                    </option>
                    <option value="allow" disabled={allowNeedsDangerConfirm}>
                      {t("settings.permissions.mode.allow", "Allow")}
                    </option>
                    <option value="deny">
                      {t("settings.permissions.mode.deny", "Deny")}
                    </option>
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {plugin.capabilities && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
            {t(
              "settings.permissions.viewCapabilities",
              "View declared capabilities",
            )}
          </summary>
          <div className="mt-2">
            <PluginCapabilitiesPreview
              preview={{
                capabilities: plugin.capabilities,
                trustedSource: plugin.trustedSource,
              }}
            />
          </div>
        </details>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <div className="flex flex-wrap gap-2">
          {plugin.tier === 3 && (
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy || codeDenied || !plugin.contentDigest}
              onClick={() =>
                void handleSingleCapabilityChange(
                  "plugin.communityCode",
                  "deny",
                )
              }
            >
              {t("settings.permissions.denyServerCode", "Deny server code")}
            </Button>
          )}

          {plugin.tier === 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={
                isBusy || declarativeCeilingDisabled || !plugin.contentDigest
              }
              onClick={() =>
                void handleSingleCapabilityChange(
                  "plugin.declarative",
                  declarativeDecision === "deny" ? "allow" : "deny",
                )
              }
            >
              {declarativeDecision === "deny"
                ? t(
                    "settings.permissions.allowDeclarative",
                    "Allow declarative",
                  )
                : t("settings.permissions.denyDeclarative", "Deny declarative")}
            </Button>
          )}
        </div>

        {plugin.grant !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={isBusy}
            onClick={() => void onRevokeGrants(plugin.pluginId)}
          >
            <Trash2 className="mr-1.5 size-3.5" />
            {t(
              "settings.permissions.revokePluginGrant",
              "Revoke persistent grants",
            )}
          </Button>
        )}
      </div>
    </article>
  );
}

export function PermissionsPluginList({
  plugins,
  ceilings,
  busyPluginId,
  onSaveGrants,
  onRevokeGrants,
}: PermissionsPluginListProps) {
  const { t, i18n } = useTranslation();
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [query, setQuery] = useState("");
  const [dangerConfirmed, setDangerConfirmed] = useState<
    Readonly<Record<string, boolean>>
  >({});

  const communityPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.source === "community"),
    [plugins],
  );
  const builtinPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.source === "builtin"),
    [plugins],
  );

  const visiblePlugins = useMemo(() => {
    const base = showBuiltin
      ? [...communityPlugins, ...builtinPlugins]
      : communityPlugins;
    const normalized = query.trim().toLowerCase();
    const filtered = normalized
      ? base.filter((plugin) => {
          const displayName = (
            resolveI18nText(plugin.name, i18n.language) || plugin.pluginId
          ).toLowerCase();
          return (
            plugin.pluginId.toLowerCase().includes(normalized) ||
            displayName.includes(normalized)
          );
        })
      : base;

    return [...filtered].sort((a, b) => {
      // Community plugins first; among them, plugins needing attention first.
      if (a.source !== b.source) return a.source === "community" ? -1 : 1;
      if (a.source === "community") {
        const aAttention =
          isGrantWarningStatus(a.grantStatus) ||
          getPluginPendingCapabilities(a, ceilings).length > 0
            ? 0
            : 1;
        const bAttention =
          isGrantWarningStatus(b.grantStatus) ||
          getPluginPendingCapabilities(b, ceilings).length > 0
            ? 0
            : 1;
        if (aAttention !== bAttention) return aAttention - bAttention;
      }
      return a.pluginId.localeCompare(b.pluginId);
    });
  }, [
    communityPlugins,
    builtinPlugins,
    showBuiltin,
    query,
    i18n.language,
    ceilings,
  ]);

  const showSearch = showBuiltin || communityPlugins.length > 2;

  return (
    <section className="space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="settings-section-title">
            {t("settings.permissions.pluginsTitle", "Per-plugin grants (L3)")}
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(
              "settings.permissions.pluginsDescription",
              "Persistent grants bind to each community package's content digest and capability snapshot. Explicit denials override trusted-source auto-approval and survive updates until cleared.",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {showSearch && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary">
              <Search
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(
                  "settings.permissions.searchPluginsPlaceholder",
                  "Filter plugins...",
                )}
                className="h-7 w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("common.clear", "Clear")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          )}
          {builtinPlugins.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                checked={showBuiltin}
                onChange={(event) => setShowBuiltin(event.target.checked)}
              />
              {t("settings.permissions.showBuiltinCount", {
                count: builtinPlugins.length,
                defaultValue: "Show bundled ({{count}})",
              })}
            </label>
          )}
        </div>
      </div>

      {visiblePlugins.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {query.trim()
            ? t(
                "settings.permissions.noMatchingPlugins",
                "No installed plugins match your filter.",
              )
            : t(
                "settings.permissions.noCommunityPlugins",
                "No third-party community plugins are currently installed.",
              )}
        </p>
      ) : (
        <div className="space-y-3">
          {visiblePlugins.map((plugin) => (
            <PluginGrantCard
              key={plugin.pluginId}
              plugin={plugin}
              ceilings={ceilings}
              isBusy={busyPluginId === plugin.pluginId}
              confirmedDanger={dangerConfirmed[plugin.pluginId] === true}
              onDangerChange={(id, checked) =>
                setDangerConfirmed((prev) => ({ ...prev, [id]: checked }))
              }
              onSaveGrants={onSaveGrants}
              onRevokeGrants={onRevokeGrants}
            />
          ))}
        </div>
      )}
    </section>
  );
}
