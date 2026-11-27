import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginDiagnosticsSnapshot, PluginSummary } from "@covel/shared";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import type { PermissionPluginSummary } from "@/services/api/permissions.js";
import { isGrantWarningStatus, toI18nSlug } from "./PermissionsPluginList.js";

export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticGroupMode = "plugin" | "category" | "flat";

export interface DiagnosticNoticeItem {
  readonly id: string;
  readonly pluginId: string;
  readonly severity: DiagnosticSeverity;
  readonly categoryKey: string;
  readonly category: string;
  readonly message: string;
  readonly count: number;
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Aggregate actionable plugin diagnostics across host load state, L3 grant/integrity
 * health, and active session execution. Normal bundled plugin code-classification
 * notes are excluded so the summary surfaces real issues and community classification
 * context without repeating identical entries.
 */
export function collectPluginDiagnostics(
  plugins: readonly PermissionPluginSummary[],
  installedPlugins: readonly PluginSummary[],
  sessionDiagnostics: PluginDiagnosticsSnapshot | null,
  t: ReturnType<typeof useTranslation>["t"],
): DiagnosticNoticeItem[] {
  const deduped = new Map<string, DiagnosticNoticeItem>();

  const push = (
    item: Omit<DiagnosticNoticeItem, "count">,
    dedupeKey?: string,
  ) => {
    const key =
      dedupeKey ?? `${item.pluginId}\0${item.categoryKey}\0${item.message}`;
    const existing = deduped.get(key);
    if (existing) {
      deduped.set(key, {
        ...existing,
        severity:
          SEVERITY_RANK[item.severity] < SEVERITY_RANK[existing.severity]
            ? item.severity
            : existing.severity,
        count: existing.count + 1,
      });
      return;
    }
    deduped.set(key, { ...item, count: 1 });
  };

  for (const plugin of installedPlugins) {
    if (plugin.hostState === "error" || plugin.error) {
      push({
        id: `load:${plugin.id}`,
        pluginId: plugin.id,
        severity: "error",
        categoryKey: "load",
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
      push({
        id: `reg:${plugin.id}`,
        pluginId: plugin.id,
        severity: "error",
        categoryKey: "registration",
        category: t(
          "settings.permissions.diagRegistrationError",
          "Registration mismatch",
        ),
        message: `${plugin.registrationError.code}: ${plugin.registrationError.registration}`,
      });
    }

    if (plugin.source === "community") {
      const isUnknownAssessment = plugin.executionMode === "unknown";
      for (const [index, diag] of (
        plugin.executionDiagnostics ?? []
      ).entries()) {
        push({
          id: `exec:${plugin.id}:${index}`,
          pluginId: plugin.id,
          severity: isUnknownAssessment ? "warning" : "info",
          categoryKey: "classification",
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
  }

  for (const plugin of plugins) {
    if (plugin.source !== "community") continue;
    if (isGrantWarningStatus(plugin.grantStatus)) {
      push({
        id: `grant:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "warning",
        categoryKey: "grant",
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
      push({
        id: `integrity:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "error",
        categoryKey: "integrity",
        category: t("settings.permissions.diagIntegrity", "Package integrity"),
        message: t(
          `settings.permissions.integrityDesc.${toI18nSlug(plugin.integrity)}`,
          plugin.integrity,
        ),
      });
    }
    const codeState = plugin.effectiveCapabilities["plugin.communityCode"];
    if (plugin.tier === 3 && codeState.effective === "deny") {
      push({
        id: `blocked-code:${plugin.pluginId}`,
        pluginId: plugin.pluginId,
        severity: "info",
        categoryKey: "blocked",
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
        push({
          id: `session-rej:${plugin.pluginId}`,
          pluginId: plugin.pluginId,
          severity: "warning",
          categoryKey: "session",
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
      push({
        id: `call:${call.callId}`,
        pluginId: call.providerPluginId,
        severity: call.outcome === "timeout" ? "warning" : "error",
        categoryKey: "service-call",
        category: t("settings.permissions.diagServiceCall", "Service call"),
        message: `${call.contract} · ${call.name} (${call.outcome}${call.errorCode ? `: ${call.errorCode}` : ""})`,
      });
    }
  }

  return [...deduped.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.pluginId.localeCompare(b.pluginId) ||
      a.category.localeCompare(b.category) ||
      a.message.localeCompare(b.message),
  );
}

function SeverityIcon({
  severity,
  className = "size-3.5 shrink-0",
}: {
  readonly severity: DiagnosticSeverity;
  readonly className?: string;
}) {
  if (severity === "error") {
    return <AlertCircle className={`${className} text-destructive`} />;
  }
  if (severity === "warning") {
    return <AlertTriangle className={`${className} text-amber-500`} />;
  }
  return <Info className={`${className} text-muted-foreground`} />;
}

interface DiagnosticGroup {
  readonly key: string;
  readonly label: string;
  readonly isMonospace: boolean;
  readonly highestSeverity: DiagnosticSeverity;
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number };
  readonly items: readonly DiagnosticNoticeItem[];
}

export function PermissionsDiagnosticsSection({
  diagnostics,
}: {
  readonly diagnostics: readonly DiagnosticNoticeItem[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<
    DiagnosticSeverity | "all"
  >("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [groupMode, setGroupMode] = useState<DiagnosticGroupMode>("plugin");
  const [expandedGroups, setExpandedGroups] = useState<
    Readonly<Record<string, boolean>>
  >({});

  const severityCounts = useMemo(() => {
    let error = 0;
    let warning = 0;
    let info = 0;
    for (const item of diagnostics) {
      if (item.severity === "error") error += 1;
      else if (item.severity === "warning") warning += 1;
      else info += 1;
    }
    return { all: diagnostics.length, error, warning, info };
  }, [diagnostics]);

  const categories = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of diagnostics) {
      if (!map.has(item.categoryKey)) {
        map.set(item.categoryKey, item.category);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [diagnostics]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return diagnostics.filter((item) => {
      if (severityFilter !== "all" && item.severity !== severityFilter) {
        return false;
      }
      if (categoryFilter !== "all" && item.categoryKey !== categoryFilter) {
        return false;
      }
      if (!normalized) return true;
      return (
        item.pluginId.toLowerCase().includes(normalized) ||
        item.category.toLowerCase().includes(normalized) ||
        item.message.toLowerCase().includes(normalized)
      );
    });
  }, [diagnostics, query, severityFilter, categoryFilter]);

  const groups = useMemo((): readonly DiagnosticGroup[] => {
    if (groupMode === "flat") return [];
    const byKey = new Map<
      string,
      { label: string; isMonospace: boolean; items: DiagnosticNoticeItem[] }
    >();
    for (const item of filtered) {
      const key =
        groupMode === "plugin" ? `plugin:${item.pluginId}` : `cat:${item.categoryKey}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.items.push(item);
      } else {
        byKey.set(key, {
          label: groupMode === "plugin" ? item.pluginId : item.category,
          isMonospace: groupMode === "plugin",
          items: [item],
        });
      }
    }
    return [...byKey.entries()]
      .map(([key, bucket]) => {
        let error = 0;
        let warning = 0;
        let info = 0;
        let highestSeverity: DiagnosticSeverity = "info";
        for (const item of bucket.items) {
          if (item.severity === "error") error += 1;
          else if (item.severity === "warning") warning += 1;
          else info += 1;
          if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[highestSeverity]) {
            highestSeverity = item.severity;
          }
        }
        return {
          key,
          label: bucket.label,
          isMonospace: bucket.isMonospace,
          highestSeverity,
          counts: { error, warning, info },
          items: bucket.items,
        };
      })
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.highestSeverity] - SEVERITY_RANK[b.highestSeverity] ||
          b.items.length - a.items.length ||
          a.label.localeCompare(b.label),
      );
  }, [filtered, groupMode]);

  const hasActiveFilter =
    query.trim().length > 0 ||
    severityFilter !== "all" ||
    categoryFilter !== "all";

  const isGroupExpanded = (group: DiagnosticGroup): boolean => {
    const explicit = expandedGroups[group.key];
    if (explicit !== undefined) return explicit;
    return (
      group.highestSeverity === "error" ||
      groups.length <= 3 ||
      query.trim().length > 0
    );
  };

  const allExpanded =
    groups.length > 0 && groups.every((group) => isGroupExpanded(group));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
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
      </div>

      {diagnostics.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-primary" />
          <span>
            {t(
              "settings.permissions.diagnosticsEmpty",
              "No plugin permission or load issues detected.",
            )}
          </span>
        </div>
      ) : (
        <>
          <div className="space-y-2.5 rounded-lg border border-border bg-card/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary">
                <Search
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <input
                  type="search"
                  aria-label={t(
                    "settings.permissions.diagnosticsSearchPlaceholder",
                    "Search by plugin, category, or message...",
                  )}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t(
                    "settings.permissions.diagnosticsSearchPlaceholder",
                    "Search by plugin, category, or message...",
                  )}
                  className="h-8 w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label={t("common.clear", "Clear")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {categories.length > 1 && (
                <select
                  aria-label={t(
                    "settings.permissions.diagnosticsCategoryFilter",
                    "Filter by category",
                  )}
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="all">
                    {t(
                      "settings.permissions.diagnosticsAllCategories",
                      "All categories",
                    )}
                  </option>
                  {categories.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              )}

              <div
                role="group"
                aria-label={t(
                  "settings.permissions.diagnosticsGroupBy",
                  "Group diagnostics",
                )}
                className="inline-flex rounded-md border border-border bg-background p-0.5 text-xs"
              >
                {(
                  [
                    [
                      "plugin",
                      t(
                        "settings.permissions.diagnosticsGroupPlugin",
                        "By plugin",
                      ),
                    ],
                    [
                      "category",
                      t(
                        "settings.permissions.diagnosticsGroupCategory",
                        "By category",
                      ),
                    ],
                    [
                      "flat",
                      t("settings.permissions.diagnosticsGroupFlat", "Flat"),
                    ],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGroupMode(mode)}
                    aria-pressed={groupMode === mode}
                    className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${
                      groupMode === mode
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    [
                      "all",
                      t("settings.permissions.diagnosticsSeverityAll", "All"),
                      severityCounts.all,
                    ],
                    [
                      "error",
                      t(
                        "settings.permissions.diagnosticsSeverityError",
                        "Errors",
                      ),
                      severityCounts.error,
                    ],
                    [
                      "warning",
                      t(
                        "settings.permissions.diagnosticsSeverityWarning",
                        "Warnings",
                      ),
                      severityCounts.warning,
                    ],
                    [
                      "info",
                      t(
                        "settings.permissions.diagnosticsSeverityInfo",
                        "Notes",
                      ),
                      severityCounts.info,
                    ],
                  ] as const
                ).map(([level, label, count]) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setSeverityFilter(level)}
                    aria-pressed={severityFilter === level}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                      severityFilter === level
                        ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span>{label}</span>
                    <span className="tabular-nums opacity-75">{count}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {groupMode !== "flat" && groups.length > 1 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      const nextState = !allExpanded;
                      setExpandedGroups(
                        Object.fromEntries(
                          groups.map((group) => [group.key, nextState]),
                        ),
                      );
                    }}
                  >
                    {allExpanded
                      ? t(
                          "settings.permissions.diagnosticsCollapseAll",
                          "Collapse all",
                        )
                      : t(
                          "settings.permissions.diagnosticsExpandAll",
                          "Expand all",
                        )}
                  </Button>
                )}
                {hasActiveFilter && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      setQuery("");
                      setSeverityFilter("all");
                      setCategoryFilter("all");
                    }}
                  >
                    {t(
                      "settings.permissions.diagnosticsResetFilters",
                      "Clear filters",
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-xs text-muted-foreground">
              <span>
                {t(
                  "settings.permissions.diagnosticsNoMatches",
                  "No diagnostic entries match the current search or filters.",
                )}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setSeverityFilter("all");
                  setCategoryFilter("all");
                }}
              >
                {t(
                  "settings.permissions.diagnosticsResetFilters",
                  "Clear filters",
                )}
              </Button>
            </div>
          ) : groupMode === "flat" ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card/30">
              {filtered.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2.5 px-3.5 py-2.5 text-xs"
                >
                  <SeverityIcon
                    severity={item.severity}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium text-foreground">
                        {item.pluginId}
                      </span>
                      <Badge
                        variant={
                          item.severity === "error" ? "destructive" : "outline"
                        }
                      >
                        {item.category}
                      </Badge>
                      {item.count > 1 && (
                        <Badge variant="secondary" className="tabular-nums">
                          ×{item.count}
                        </Badge>
                      )}
                    </div>
                    <p className="wrap-break-word text-muted-foreground leading-relaxed">
                      {item.message}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-2">
              {groups.map((group) => {
                const expanded = isGroupExpanded(group);
                return (
                  <div
                    key={group.key}
                    className="overflow-hidden rounded-lg border border-border bg-card/30"
                  >
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedGroups((prev) => ({
                          ...prev,
                          [group.key]: !expanded,
                        }))
                      }
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-xs transition-colors hover:bg-muted/40"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {expanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <SeverityIcon severity={group.highestSeverity} />
                        <span
                          className={`shrink-0 font-medium text-foreground ${
                            group.isMonospace ? "font-mono" : ""
                          }`}
                        >
                          {group.label}
                        </span>
                        {!expanded && group.items[0] && (
                          <span className="hidden min-w-0 truncate text-muted-foreground sm:inline">
                            — {group.items[0].message}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {group.counts.error > 0 && (
                          <Badge
                            variant="destructive"
                            className="tabular-nums"
                          >
                            {group.counts.error}
                          </Badge>
                        )}
                        {group.counts.warning > 0 && (
                          <Badge variant="outline" className="tabular-nums">
                            {t("settings.permissions.diagnosticsCountWarn", {
                              count: group.counts.warning,
                              defaultValue: "{{count}} warn",
                            })}
                          </Badge>
                        )}
                        {group.items.length !== group.counts.error &&
                          group.items.length !== group.counts.warning && (
                            <Badge variant="secondary" className="tabular-nums">
                              {t("settings.permissions.diagnosticsGroupCount", {
                                count: group.items.length,
                                defaultValue: "{{count}}",
                              })}
                            </Badge>
                          )}
                      </div>
                    </button>

                    {expanded && (
                      <ul className="divide-y divide-border/70 border-t border-border bg-background/50">
                        {group.items.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-start gap-2.5 px-3.5 py-2 text-xs"
                          >
                            <SeverityIcon
                              severity={item.severity}
                              className="mt-0.5 size-3.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-2">
                                {groupMode === "plugin" ? (
                                  <Badge
                                    variant={
                                      item.severity === "error"
                                        ? "destructive"
                                        : "outline"
                                    }
                                  >
                                    {item.category}
                                  </Badge>
                                ) : (
                                  <span className="font-mono font-medium text-foreground">
                                    {item.pluginId}
                                  </span>
                                )}
                                {item.count > 1 && (
                                  <Badge
                                    variant="secondary"
                                    className="tabular-nums"
                                  >
                                    ×{item.count}
                                  </Badge>
                                )}
                              </div>
                              <p className="wrap-break-word text-muted-foreground leading-relaxed">
                                {item.message}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
