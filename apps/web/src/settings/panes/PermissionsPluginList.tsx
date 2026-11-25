import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  resolveI18nText,
  type PluginDiagnosticsSnapshot,
  type PluginSummary,
} from "@covel/shared";
import type {
  CapabilityCeiling,
  CapabilityKey,
  PluginGrantDecisions,
} from "@covel/shared/permissions";
import { AlertTriangle, CheckCircle2, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type { PermissionPluginSummary } from "@/services/api/permissions.js";
import { PluginCapabilitiesPreview } from "./PluginCapabilitiesPreview.js";

interface PermissionsPluginListProps {
  readonly plugins: readonly PermissionPluginSummary[];
  readonly installedPlugins: readonly PluginSummary[];
  readonly sessionDiagnostics: PluginDiagnosticsSnapshot | null;
  readonly ceilings: Readonly<Record<CapabilityKey, CapabilityCeiling>>;
  readonly busyPluginId: string | null;
  readonly onSaveGrants: (
    pluginId: string,
    decisions: PluginGrantDecisions,
    expectedDigest?: string,
  ) => Promise<boolean>;
  readonly onRevokeGrants: (pluginId: string) => Promise<void>;
}

interface DiagnosticNoticeItem {
  readonly id: string;
  readonly pluginId: string;
  readonly severity: "error" | "warning" | "info";
  readonly category: string;
  readonly message: string;
}

export function toI18nSlug(value: string): string {
  return value.replaceAll(".", "_").replaceAll("-", "_");
}

function isGrantWarningStatus(
  status: PermissionPluginSummary["grantStatus"],
): boolean {
  return (
    status === "stale-digest" ||
    status === "capability-escalated" ||
    status === "unreadable"
  );
}

function collectDiagnostics(
  plugins: readonly PermissionPluginSummary[],
  installedPlugins: readonly PluginSummary[],
  sessionDiagnostics: PluginDiagnosticsSnapshot | null,
  t: ReturnType<typeof useTranslation>["t"],
): DiagnosticNoticeItem[] {
  const items: DiagnosticNoticeItem[] = [];

  for (const plugin of installedPlugins) {
    if (plugin.hostState === "error" || plugin.error) {
      items.push({
        id: `load:${plugin.id}`,
        pluginId: plugin.id,
        severity: "error",
        category: t("settings.permissions.diagLoadError", "Load error"),
        message:
          plugin.error ??
          t(
            "settings.permissions.diagLoadErrorFallback",
            "Plugin failed to load cleanly on the host.",
          ),
      });
    }
    if (plugin.registrationError) {
      items.push({
        id: `reg:${plugin.id}`,
        pluginId: plugin.id,
        severity: "error",
        category: t(
          "settings.permissions.diagRegistrationError",
          "Registration mismatch",
        ),
        message: `${plugin.registrationError.code}: ${plugin.registrationError.registration}`,
      });
    }
    for (const [index, diag] of (plugin.executionDiagnostics ?? []).entries()) {
      items.push({
        id: `exec:${plugin.id}:${index}`,
        pluginId: plugin.id,
        severity: "warning",
        category: t(
          "settings.permissions.diagExecutionNotice",
          "Manifest classification",
        ),
        message: diag.field
          ? `${diag.file} (${diag.field}): ${diag.message}`
          : `${diag.file}: ${diag.message}`,
      });
    }
  }

  for (const plugin of plugins) {
    if (plugin.source !== "community") continue;
    if (isGrantWarningStatus(plugin.grantStatus)) {
      items.push({
        id: `grant:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "warning",
        category: t(
          "settings.permissions.diagGrantInvalidated",
          "Grant invalidated",
        ),
        message: t(
          `settings.permissions.grantStatusDesc.${toI18nSlug(plugin.grantStatus)}`,
          plugin.grantStatus,
        ),
      });
    }
    if (plugin.integrity === "modified" || plugin.integrity === "unreadable") {
      items.push({
        id: `integrity:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "error",
        category: t("settings.permissions.diagIntegrity", "Package integrity"),
        message: t(
          `settings.permissions.integrityDesc.${toI18nSlug(plugin.integrity)}`,
          plugin.integrity,
        ),
      });
    }
    const codeState = plugin.effectiveCapabilities["plugin.communityCode"];
    if (plugin.tier === 3 && codeState.effective === "deny") {
      items.push({
        id: `blocked-code:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "info",
        category: t("settings.permissions.diagBlocked", "Blocked by policy"),
        message: t(
          "settings.permissions.diagBlockedCode",
          "Server-side code execution is denied for this plugin.",
        ),
      });
    }
  }

  if (sessionDiagnostics) {
    for (const plugin of sessionDiagnostics.plugins) {
      if (plugin.rejection) {
        items.push({
          id: `session-rej:${plugin.pluginId}`,
          pluginId: plugin.pluginId,
          severity: "warning",
          category: t(
            "settings.permissions.diagSessionRejection",
            "Session selection",
          ),
          message: `${plugin.rejection.code}: ${plugin.rejection.reason}`,
        });
      }
    }
    for (const call of sessionDiagnostics.calls) {
      if (call.outcome === "success") continue;
      items.push({
        id: `call:${call.callId}`,
        pluginId: call.providerPluginId,
        severity: call.outcome === "timeout" ? "warning" : "error",
        category: t("settings.permissions.diagServiceCall", "Service call"),
        message: `${call.contract} · ${call.name} (${call.outcome}${call.errorCode ? `: ${call.errorCode}` : ""})`,
      });
    }
  }

  return items;
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
  const codeDecision = plugin.grant?.decisions["plugin.communityCode"];
  const declarativeDecision = plugin.grant?.decisions["plugin.declarative"];
  const hasValidCodeAllow =
    plugin.grantStatus === "valid" && codeDecision === "allow";
  const codeDenied = codeDecision === "deny";
  const codeCeilingDisabled = ceilings["plugin.communityCode"] === "disabled";
  const declarativeCeilingDisabled =
    ceilings["plugin.declarative"] === "disabled";
  const grantWarning = isCommunity && isGrantWarningStatus(plugin.grantStatus);

  return (
    <article className="space-y-3 rounded border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold wrap-break-word">
              {displayName}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {plugin.pluginId}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              v{plugin.version}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {t(`settings.permissions.source.${plugin.source}`, plugin.source)}
            </Badge>
            <Badge variant={plugin.tier === 0 ? "secondary" : "outline"}>
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
              <Badge variant="default">
                {t("settings.trustedSources.badge")}
              </Badge>
            )}
            <Badge
              variant={
                plugin.grantStatus === "valid"
                  ? "default"
                  : grantWarning
                    ? "destructive"
                    : "outline"
              }
            >
              {t(
                `settings.permissions.grantStatus.${toI18nSlug(plugin.grantStatus)}`,
                plugin.grantStatus,
              )}
            </Badge>
          </div>
        </div>
        {plugin.contentDigest && (
          <span
            title={plugin.contentDigest}
            className="font-mono text-xs text-muted-foreground"
          >
            {plugin.contentDigest.slice(0, 12)}
          </span>
        )}
      </div>

      {grantWarning && (
        <div
          role="status"
          className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
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

      {plugin.capabilities && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-primary hover:underline">
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

      {isCommunity && (
        <div className="space-y-2 border-t border-border pt-2">
          {plugin.tier === 3 && !hasValidCodeAllow && (
            <div className="space-y-1.5 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
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
              <label className="flex items-start gap-2 text-foreground">
                <input
                  type="checkbox"
                  checked={confirmedDanger}
                  disabled={
                    isBusy || codeCeilingDisabled || !plugin.contentDigest
                  }
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
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {plugin.tier === 3 && !hasValidCodeAllow && (
              <Button
                size="sm"
                disabled={
                  isBusy ||
                  codeCeilingDisabled ||
                  !plugin.contentDigest ||
                  !confirmedDanger
                }
                onClick={() => {
                  const nextDecisions: PluginGrantDecisions = {
                    ...plugin.grant?.decisions,
                    "plugin.communityCode": "allow",
                  };
                  void onSaveGrants(
                    plugin.pluginId,
                    nextDecisions,
                    plugin.contentDigest ?? undefined,
                  ).then((saved) => {
                    if (saved) onDangerChange(plugin.pluginId, false);
                  });
                }}
              >
                {t("settings.permissions.grantServerCode", "Grant server code")}
              </Button>
            )}

            {plugin.tier === 3 && (
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy || codeDenied || !plugin.contentDigest}
                onClick={() => {
                  const nextDecisions: PluginGrantDecisions = {
                    ...plugin.grant?.decisions,
                    "plugin.communityCode": "deny",
                  };
                  void onSaveGrants(
                    plugin.pluginId,
                    nextDecisions,
                    plugin.contentDigest ?? undefined,
                  );
                }}
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
                onClick={() => {
                  const nextDecisions: PluginGrantDecisions = {
                    ...plugin.grant?.decisions,
                    "plugin.declarative":
                      declarativeDecision === "deny" ? "allow" : "deny",
                  };
                  void onSaveGrants(
                    plugin.pluginId,
                    nextDecisions,
                    plugin.contentDigest ?? undefined,
                  );
                }}
              >
                {declarativeDecision === "deny"
                  ? t(
                      "settings.permissions.allowDeclarative",
                      "Allow declarative",
                    )
                  : t(
                      "settings.permissions.denyDeclarative",
                      "Deny declarative",
                    )}
              </Button>
            )}

            {plugin.grant !== null && (
              <Button
                size="sm"
                variant="outline"
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
        </div>
      )}
    </article>
  );
}

function PluginDiagnosticsSection({
  diagnostics,
}: {
  readonly diagnostics: readonly DiagnosticNoticeItem[];
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <div>
        <h3 className="settings-section-title">
          {t("settings.permissions.diagnosticsTitle", "Plugin diagnostics")}
        </h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t(
            "settings.permissions.diagnosticsDescription",
            "Aggregated load errors, registration mismatches, manifest classification notes, grant invalidations, and recent blocked or failed calls.",
          )}
        </p>
      </div>

      {diagnostics.length === 0 ? (
        <div className="flex items-center gap-2 rounded border border-border px-3 py-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
          <span>
            {t(
              "settings.permissions.diagnosticsEmpty",
              "No plugin permission or load issues detected.",
            )}
          </span>
        </div>
      ) : (
        <ul className="space-y-2">
          {diagnostics.map((item) => (
            <li
              key={item.id}
              className={`rounded border px-3 py-2 text-xs ${
                item.severity === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-border bg-background text-foreground"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2 font-medium">
                <span className="font-mono">{item.pluginId}</span>
                <Badge
                  variant={
                    item.severity === "error" ? "destructive" : "outline"
                  }
                >
                  {item.category}
                </Badge>
              </div>
              <p className="mt-1 wrap-break-word text-muted-foreground">
                {item.message}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PermissionsPluginList({
  plugins,
  installedPlugins,
  sessionDiagnostics,
  ceilings,
  busyPluginId,
  onSaveGrants,
  onRevokeGrants,
}: PermissionsPluginListProps) {
  const { t } = useTranslation();
  const [showBuiltin, setShowBuiltin] = useState(false);
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
  const visiblePlugins = showBuiltin ? plugins : communityPlugins;

  const diagnostics = useMemo(
    () => collectDiagnostics(plugins, installedPlugins, sessionDiagnostics, t),
    [plugins, installedPlugins, sessionDiagnostics, t],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
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
          {builtinPlugins.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
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

        {visiblePlugins.length === 0 ? (
          <p className="rounded border border-border px-3 py-2 text-xs text-muted-foreground">
            {t(
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

      <PluginDiagnosticsSection diagnostics={diagnostics} />
    </div>
  );
}
