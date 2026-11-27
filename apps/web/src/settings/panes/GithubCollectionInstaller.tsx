import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronRight,
  Code2,
  ExternalLink,
  FolderGit2,
  Globe,
  Loader2,
  PackageCheck,
  Puzzle,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { resolveI18nText } from "@covel/shared";
import type {
  GithubBatchInstallResult,
  GithubCollectionPreview,
  GithubPackagePreview,
} from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { OutboundNetworkErrorBanner } from "@/components/shared/outbound-network-error-banner.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  parseOutboundNetworkError,
  type OutboundNetworkErrorInfo,
} from "@/lib/outbound-network-error.js";
import {
  installGithubPackages,
  previewGithubCollection,
} from "@/services/api.js";
import { PluginCapabilitiesPreview } from "./PluginCapabilitiesPreview.js";
import {
  SUGGESTED_PLUGIN_REPOSITORY,
  SUGGESTED_WORLD_REPOSITORY,
} from "./package-suggestions.js";
import { GithubPackageRiskConsent } from "./GithubPackageRiskConsent.js";

type KindFilter = "all" | "plugin" | "world";

function topFolderOf(path: string): string {
  const first = path.split("/").filter(Boolean)[0];
  return first ?? "";
}

function folderPriority(folder: string): number {
  const normalized = folder.toLowerCase();
  if (normalized === "plugins") return 0;
  if (normalized === "worlds") return 1;
  if (normalized === "examples" || normalized === "example") return 3;
  return 2;
}

function capabilityCount(item: GithubPackagePreview): number {
  if (item.kind !== "plugin") return 0;
  const c = item.capabilities;
  let count = c.serverCode ? 1 : 0;
  if (c.instanceScope) count += 1;
  if (c.secrets) count += 1;
  if (c.authProxy) count += 1;
  if (c.loopbackCallback) count += 1;
  if (c.scheduler) count += 1;
  if (c.sandboxWorker) count += 1;
  count += (c.providerSources?.length ?? 0) > 0 ? 1 : 0;
  count += (c.flows?.length ?? 0) > 0 ? 1 : 0;
  count += (c.appActions?.length ?? 0) > 0 ? 1 : 0;
  count += (c.appEvents?.length ?? 0) > 0 ? 1 : 0;
  count += c.http.length > 0 ? 1 : 0;
  count += c.hooks.length > 0 ? 1 : 0;
  count += c.tools.length > 0 ? 1 : 0;
  count += c.services.length > 0 ? 1 : 0;
  count += c.actions.length > 0 ? 1 : 0;
  count += c.wires.length > 0 ? 1 : 0;
  count += c.forms.length > 0 ? 1 : 0;
  count += c.extensions.length > 0 ? 1 : 0;
  count += c.datasets.length > 0 ? 1 : 0;
  return count;
}

function shortRepoLabel(repository: string): string {
  return repository.replace(/^https:\/\/github\.com\//i, "");
}

/**
 * One GitHub install flow for plugins, worlds and collections. The link is
 * previewed once, the user searches/filters and ticks what to install, consents
 * once, and the selection is installed as a unit: all of it or none of it.
 */
export function GithubCollectionInstaller({
  onInstalled,
  disabled = false,
  onBusyChange,
  installedPluginIds,
  installedWorldIds,
  onOpenProxySettings,
}: {
  onInstalled: (result: GithubBatchInstallResult) => void;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  installedPluginIds?: ReadonlySet<string>;
  installedWorldIds?: ReadonlySet<string>;
  onOpenProxySettings?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<GithubCollectionPreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outboundError, setOutboundError] =
    useState<OutboundNetworkErrorInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const isItemInstalled = (item: GithubPackagePreview): boolean =>
    item.kind === "world"
      ? (installedWorldIds?.has(item.id) ?? false)
      : (installedPluginIds?.has(item.id) ?? false);

  const rawItems = preview?.items ?? [];

  // For repository directory scans (non-collection), place production plugins
  // and worlds ahead of example demos, and place not-yet-installed items first.
  const orderedItems = useMemo(() => {
    if (preview?.collection || rawItems.length <= 1) return rawItems;
    return [...rawItems].sort((a, b) => {
      const folderDiff =
        folderPriority(topFolderOf(a.source.path)) -
        folderPriority(topFolderOf(b.source.path));
      if (folderDiff !== 0) return folderDiff;
      const installedDiff =
        Number(isItemInstalled(a)) - Number(isItemInstalled(b));
      if (installedDiff !== 0) return installedDiff;
      const nameA = (
        (a.displayName ? resolveDisplayText(a.displayName, i18n.language) : "") ||
        a.id
      ).toLowerCase();
      const nameB = (
        (b.displayName ? resolveDisplayText(b.displayName, i18n.language) : "") ||
        b.id
      ).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [
    preview?.collection,
    rawItems,
    i18n.language,
    installedPluginIds,
    installedWorldIds,
  ]);

  const kindCounts = useMemo(() => {
    let plugins = 0;
    let worlds = 0;
    for (const item of orderedItems) {
      if (item.kind === "world") worlds += 1;
      else plugins += 1;
    }
    return { plugins, worlds };
  }, [orderedItems]);

  const folderGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of orderedItems) {
      const folder = topFolderOf(item.source.path);
      if (!folder) continue;
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      const diff = folderPriority(a[0]) - folderPriority(b[0]);
      return diff !== 0 ? diff : a[0].localeCompare(b[0]);
    });
  }, [orderedItems]);

  const sharedSource = useMemo(() => {
    if (orderedItems.length === 0) return null;
    const first = orderedItems[0]!.source;
    const allSame = orderedItems.every(
      (item) =>
        item.source.repository === first.repository &&
        item.source.commit === first.commit,
    );
    return allSame
      ? { repository: first.repository, commit: first.commit }
      : null;
  }, [orderedItems]);

  const problemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const problem of preview?.problems ?? []) {
      if (problem.level === "error" && problem.packageId) {
        ids.add(problem.packageId);
      }
    }
    return ids;
  }, [preview?.problems]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orderedItems.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (folderFilter !== "all" && topFolderOf(item.source.path) !== folderFilter)
        return false;
      if (onlySelected && !selected.has(item.token)) return false;
      if (!q) return true;
      const displayName = item.displayName
        ? resolveDisplayText(item.displayName, i18n.language)
        : "";
      const description = item.description
        ? resolveI18nText(item.description, i18n.language)
        : "";
      const haystack = [
        item.id,
        displayName,
        description,
        item.author ?? "",
        item.source.path,
        ...(item.tags ?? []),
        ...(item.capabilities.providerSources ?? []),
        ...item.capabilities.wires,
        ...item.capabilities.tools,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [
    orderedItems,
    kindFilter,
    folderFilter,
    onlySelected,
    selected,
    searchQuery,
    i18n.language,
  ]);

  const chosen = useMemo(
    () => orderedItems.filter((item) => selected.has(item.token)),
    [orderedItems, selected],
  );

  // An error about one package blocks only a selection that contains it; an
  // error about the set as a whole (a host version range) blocks everything.
  const blocked = (preview?.problems ?? []).some(
    (problem) =>
      problem.level === "error" &&
      (!problem.packageId ||
        chosen.some((item) => item.id === problem.packageId)),
  );

  function resetFilters() {
    setSearchQuery("");
    setKindFilter("all");
    setFolderFilter("all");
    setOnlySelected(false);
  }

  function reset() {
    setPreview(null);
    setSelected(new Set());
    setAccepted(false);
    setError(null);
    setOutboundError(null);
    resetFilters();
  }

  async function inspect(targetUrl?: string) {
    const rawTarget = (targetUrl ?? url).trim();
    if (!rawTarget) return;
    if (targetUrl !== undefined) {
      setUrl(targetUrl);
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("preview");
    onBusyChange(true);
    reset();
    try {
      const result = await previewGithubCollection(rawTarget, controller.signal);
      if (!controller.signal.aborted) {
        setPreview(result);
        // Collections and single-package links pre-select their non-installed
        // packages; multi-package directory scans start unselected so users can
        // search and pick only the specific package(s) they want.
        const shouldAutoSelect =
          result.collection !== null || result.items.length === 1;
        setSelected(
          shouldAutoSelect
            ? new Set(
                result.items
                  .filter((item) => !isItemInstalled(item))
                  .map((item) => item.token),
              )
            : new Set(),
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const parsed = parseOutboundNetworkError(err);
        if (parsed) {
          setOutboundError(parsed);
          setError(null);
        } else {
          setOutboundError(null);
          setError(
            err instanceof Error ? err.message : t("settings.github.failed"),
          );
        }
      }
    } finally {
      if (requestRef.current === controller) {
        setBusy(null);
        onBusyChange(false);
        requestRef.current = null;
      }
    }
  }

  async function install() {
    if (!preview || chosen.length === 0 || !accepted || blocked) return;
    setBusy("install");
    onBusyChange(true);
    setError(null);
    setOutboundError(null);
    try {
      const tokens = chosen.map((item) => item.token);
      const result = await installGithubPackages(tokens);
      onInstalled(result);
      setPreview({
        ...preview,
        items: preview.items.filter((item) => !tokens.includes(item.token)),
      });
      setSelected(new Set());
      setAccepted(false);
      setOnlySelected(false);
    } catch (err) {
      const parsed = parseOutboundNetworkError(err);
      if (parsed) {
        setOutboundError(parsed);
        setError(null);
      } else {
        setOutboundError(null);
        setError(
          err instanceof Error ? err.message : t("settings.github.failed"),
        );
      }
    } finally {
      setBusy(null);
      onBusyChange(false);
    }
  }

  function updateSelection(next: Set<string>) {
    setSelected(next);
    // Consent covers one exact selection.
    setAccepted(false);
    setError(null);
    setOutboundError(null);
    if (next.size === 0) setOnlySelected(false);
  }

  const toggleToken = (token: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(token);
    else next.delete(token);
    updateSelection(next);
  };

  const selectAllVisible = () => {
    const next = new Set(selected);
    for (const item of filteredItems) {
      if (!isItemInstalled(item)) next.add(item.token);
    }
    updateSelection(next);
  };

  const clearSelection = () => {
    updateSelection(new Set());
  };

  const isMultiItem = orderedItems.length > 1;
  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    kindFilter !== "all" ||
    folderFilter !== "all" ||
    onlySelected;

  const pluginRepoUrl = `https://github.com/${SUGGESTED_PLUGIN_REPOSITORY}`;
  const worldRepoUrl = `https://github.com/${SUGGESTED_WORLD_REPOSITORY}`;

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="settings-section-title flex items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
            {t("settings.github.title")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.github.description")}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <a
            className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            href={pluginRepoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("settings.github.browse")}
            <ExternalLink className="h-3 w-3" />
          </a>
          <a
            className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            href={worldRepoUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("settings.github.browseWorlds")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </span>
      </div>

      <div className="space-y-2.5">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void inspect();
          }}
        >
          <label
            className="min-w-0 flex-1 text-xs text-muted-foreground"
            htmlFor="github-package-url"
          >
            {t("settings.github.url")}
            <input
              id="github-package-url"
              type="url"
              required
              value={url}
              disabled={disabled || !!busy}
              placeholder="https://github.com/author/repository"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
              onChange={(event) => {
                setUrl(event.target.value);
                reset();
              }}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            className="h-9 px-4"
            disabled={disabled || !!busy || !url.trim()}
          >
            {busy === "preview" && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t(
              busy === "preview"
                ? "settings.github.inspecting"
                : "settings.github.inspect",
            )}
          </Button>
          {busy === "preview" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => requestRef.current?.abort()}
            >
              {t("settings.github.cancel")}
            </Button>
          )}
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{t("settings.github.quickRepositories")}</span>
          <button
            type="button"
            disabled={disabled || !!busy}
            onClick={() => void inspect(pluginRepoUrl)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
          >
            <Puzzle className="h-3 w-3 text-muted-foreground" />
            {t("settings.github.officialPluginsRepo")}
            <span className="font-mono text-[10px] text-muted-foreground">
              {SUGGESTED_PLUGIN_REPOSITORY}
            </span>
          </button>
          <button
            type="button"
            disabled={disabled || !!busy}
            onClick={() => void inspect(worldRepoUrl)}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
          >
            <Globe className="h-3 w-3 text-muted-foreground" />
            {t("settings.github.officialWorldsRepo")}
            <span className="font-mono text-[10px] text-muted-foreground">
              {SUGGESTED_WORLD_REPOSITORY}
            </span>
          </button>
        </div>
      </div>

      {outboundError && (
        <OutboundNetworkErrorBanner
          info={outboundError}
          disabled={disabled || !!busy}
          onRetry={() => void inspect()}
          onOpenProxySettings={onOpenProxySettings}
        />
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive wrap-break-word"
        >
          {error}
        </p>
      )}

      {preview && orderedItems.length > 0 && (
        <div className="space-y-3 border-t border-border/70 pt-3 text-xs">
          {/* Header summary bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              {preview.collection ? (
                <p className="text-sm font-semibold text-foreground">
                  {t("settings.github.collection", {
                    name:
                      resolveDisplayText(
                        preview.collection.name,
                        i18n.language,
                      ) || preview.collection.id,
                  })}
                  {preview.collection.version
                    ? ` · ${preview.collection.version}`
                    : ""}
                  {preview.collection.author
                    ? ` · ${preview.collection.author}`
                    : ""}
                </p>
              ) : sharedSource ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {shortRepoLabel(sharedSource.repository)}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {t("settings.github.packageCount", {
                      count: orderedItems.length,
                    })}
                  </span>
                  <a
                    href={`${sharedSource.repository}/tree/${sharedSource.commit}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    title={sharedSource.commit}
                  >
                    @{sharedSource.commit.slice(0, 7)}
                  </a>
                </div>
              ) : null}
              <p className="text-muted-foreground">
                {!preview.collection && isMultiItem
                  ? t("settings.github.catalogHint")
                  : t("settings.github.multiple")}
              </p>
            </div>

            {isMultiItem && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full border border-border bg-background/80 px-2.5 py-0.5 text-[11px] font-medium text-foreground">
                  {t("settings.github.selectedSummary", {
                    selected: chosen.length,
                    total: orderedItems.length,
                  })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={disabled || !!busy || filteredItems.length === 0}
                  onClick={selectAllVisible}
                >
                  {t("settings.github.selectVisible")}
                </Button>
                {chosen.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={disabled || !!busy}
                    onClick={clearSelection}
                  >
                    {t("settings.github.clearSelection")}
                  </Button>
                )}
              </div>
            )}
          </div>

          {preview.problems.length > 0 && (
            <ul
              className="space-y-1 rounded-md border border-(--accent-warning)/30 bg-(--accent-warning)/5 p-2.5"
              data-testid="github-preview-problems"
            >
              {preview.problems.map((problem, index) => (
                <li
                  key={index}
                  className={`wrap-break-word ${
                    problem.level === "error"
                      ? "text-destructive"
                      : "text-(--accent-warning)"
                  }`}
                >
                  {problem.message}
                </li>
              ))}
            </ul>
          )}

          {/* Search & filter controls for multi-package repositories */}
          {isMultiItem && (
            <div className="space-y-2 rounded-md border border-border/80 bg-background/50 p-2.5">
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  aria-label={t("settings.github.searchPlaceholder")}
                  placeholder={t("settings.github.searchPlaceholder")}
                  className="h-8 w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label={t("common.clear", "Clear")}
                    onClick={() => setSearchQuery("")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {(folderGroups.length > 1 ||
                (kindCounts.plugins > 0 && kindCounts.worlds > 0) ||
                chosen.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {kindCounts.plugins > 0 && kindCounts.worlds > 0 && (
                    <>
                      {(
                        [
                          {
                            id: "all",
                            label: t("settings.github.filterAll", {
                              count: orderedItems.length,
                            }),
                          },
                          {
                            id: "plugin",
                            label: `${t("settings.github.kindPlugin")} (${kindCounts.plugins})`,
                          },
                          {
                            id: "world",
                            label: `${t("settings.github.kindWorld")} (${kindCounts.worlds})`,
                          },
                        ] as const
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setKindFilter(tab.id)}
                          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                            kindFilter === tab.id
                              ? "bg-primary text-primary-foreground font-medium"
                              : "border border-border bg-background text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </>
                  )}

                  {folderGroups.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setFolderFilter("all")}
                        className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                          folderFilter === "all"
                            ? "bg-primary text-primary-foreground font-medium"
                            : "border border-border bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t("settings.github.filterAllFolders", {
                          count: orderedItems.length,
                        })}
                      </button>
                      {folderGroups.map(([folder, count]) => (
                        <button
                          key={folder}
                          type="button"
                          onClick={() => setFolderFilter(folder)}
                          className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                            folderFilter === folder
                              ? "bg-primary text-primary-foreground font-medium"
                              : "border border-border bg-background text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {folder}/ ({count})
                        </button>
                      ))}
                    </>
                  )}

                  {chosen.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setOnlySelected((prev) => !prev)}
                      className={`ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                        onlySelected
                          ? "bg-primary text-primary-foreground font-medium"
                          : "border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
                      }`}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {t("settings.github.filterSelectedOnly", {
                        count: chosen.length,
                      })}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Active selection chips when browsing a multi-item repo */}
          {isMultiItem && chosen.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2">
              <span className="text-[11px] font-medium text-foreground">
                {t("settings.github.selectedChipsLabel")}
              </span>
              {chosen.map((item) => {
                const label =
                  (item.displayName
                    ? resolveDisplayText(item.displayName, i18n.language)
                    : "") || item.id;
                return (
                  <span
                    key={item.token}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-background px-2 py-0.5 text-[11px] text-foreground"
                  >
                    <span className="font-medium">{label}</span>
                    {label !== item.id && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {item.id}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={disabled || !!busy}
                      aria-label={t("settings.github.removeFromSelection", {
                        id: item.id,
                      })}
                      onClick={() => toggleToken(item.token, false)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Package cards */}
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background/40 px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                {t("settings.github.noMatchingPackages")}
              </p>
              {hasActiveFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={resetFilters}
                >
                  {t("settings.github.resetFilters")}
                </Button>
              )}
            </div>
          ) : (
            <ul
              className={`space-y-2 ${
                orderedItems.length > 4
                  ? "max-h-104 overflow-y-auto pr-1"
                  : ""
              }`}
            >
              {filteredItems.map((item) => {
                const isChecked = selected.has(item.token);
                const installed = isItemInstalled(item);
                const hasError = problemIds.has(item.id);
                const folder = topFolderOf(item.source.path);
                const displayName = item.displayName
                  ? resolveDisplayText(item.displayName, i18n.language)
                  : "";
                const title = displayName || item.id;
                const description = item.description
                  ? resolveI18nText(item.description, i18n.language)
                  : "";
                const capCount = capabilityCount(item);
                const sourceTreeUrl = `${item.source.repository}/tree/${item.source.commit}${item.source.path ? `/${item.source.path}` : ""}`;

                return (
                  <li
                    key={item.token}
                    className={`rounded-lg border transition-colors ${
                      hasError
                        ? "border-destructive/40 bg-destructive/5"
                        : isChecked
                          ? "border-primary/50 bg-primary/5"
                          : "border-border bg-background/70 hover:bg-muted/20"
                    }`}
                  >
                    <label className="flex cursor-pointer items-start gap-3 p-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 accent-primary"
                        checked={isChecked}
                        disabled={disabled || !!busy}
                        onChange={(event) =>
                          toggleToken(item.token, event.target.checked)
                        }
                      />
                      <span className="min-w-0 flex-1 space-y-1.5 wrap-break-word">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-foreground">
                            {title}
                          </span>
                          {title !== item.id && (
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {item.id}
                            </span>
                          )}
                          {item.version && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              v{item.version}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {item.kind === "world" ? (
                              <Globe className="h-2.5 w-2.5" />
                            ) : (
                              <Puzzle className="h-2.5 w-2.5" />
                            )}
                            {t(
                              item.kind === "world"
                                ? "settings.github.kindWorld"
                                : "settings.github.kindPlugin",
                            )}
                          </span>
                          {folder && folderGroups.length > 1 && (
                            <span
                              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                folder.toLowerCase() === "examples"
                                  ? "bg-muted/70 text-muted-foreground"
                                  : "bg-secondary/60 text-secondary-foreground"
                              }`}
                            >
                              {folder}/
                            </span>
                          )}
                          {item.hasServerCode && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-(--accent-warning)/15 px-1.5 py-0.5 text-[10px] font-medium text-(--accent-warning)">
                              <Code2 className="h-2.5 w-2.5" />
                              {t("settings.github.hasCode")}
                            </span>
                          )}
                          {item.trustedSource && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              <ShieldCheck className="h-2.5 w-2.5" />
                              {t("settings.trustedSources.badge")}
                            </span>
                          )}
                          {installed && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                              <PackageCheck className="h-2.5 w-2.5" />
                              {t("settings.github.alreadyInstalled")}
                            </span>
                          )}
                        </span>

                        {description && (
                          <span className="block text-xs leading-relaxed text-muted-foreground">
                            {description}
                          </span>
                        )}

                        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                          {item.author && (
                            <span>
                              {t("package.authorLine", { author: item.author })}
                            </span>
                          )}
                          {item.tags && item.tags.length > 0 && (
                            <span className="flex flex-wrap items-center gap-1">
                              {item.tags.slice(0, 5).map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </span>
                    </label>

                    <div className="border-t border-border/60 px-3 py-1.5">
                      <details
                        open={orderedItems.length === 1}
                        className="group text-[11px]"
                      >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-muted-foreground hover:text-foreground">
                          <span className="inline-flex items-center gap-1">
                            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                            {item.kind === "plugin"
                              ? t("settings.github.detailsTogglePlugin", {
                                  count: capCount,
                                })
                              : t("settings.github.detailsToggleWorld")}
                          </span>
                          <a
                            href={sourceTreeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {shortRepoLabel(item.source.repository)}
                            {item.source.path ? `/${item.source.path}` : ""}
                            <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        </summary>
                        <div className="mt-2 space-y-2 pb-1">
                          {item.kind === "plugin" && (
                            <PluginCapabilitiesPreview preview={item} />
                          )}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-muted/30 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                            <a
                              href={sourceTreeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:text-foreground"
                            >
                              {item.source.repository}
                              {item.source.path ? ` / ${item.source.path}` : ""}
                            </a>
                            <span className="break-all">
                              {item.source.commit}
                            </span>
                          </div>
                        </div>
                      </details>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {chosen.length > 0 && (
            <GithubPackageRiskConsent
              kind={
                chosen.some((item) => item.kind === "plugin")
                  ? "plugin"
                  : "world"
              }
              includesWorld={chosen.some((item) => item.kind === "world")}
              hasServerCode={chosen.some((item) => item.hasServerCode)}
              accepted={accepted}
              disabled={disabled || !!busy}
              onChange={setAccepted}
            />
          )}
          {blocked && (
            <p role="alert" className="text-destructive">
              {t("settings.github.blocked")}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              size="sm"
              disabled={
                chosen.length === 0 || !accepted || blocked || !!busy || disabled
              }
              onClick={() => void install()}
            >
              {busy === "install" && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              {busy === "install"
                ? t("settings.github.installing")
                : t("settings.github.installSelected", {
                    count: chosen.length,
                  })}
            </Button>
            {isMultiItem && chosen.length === 0 && (
              <span className="text-[11px] text-muted-foreground">
                {t("settings.github.selectToInstallHint")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
