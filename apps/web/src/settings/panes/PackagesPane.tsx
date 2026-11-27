import { SettingsListFilter, SettingsListSearch } from "../list-controls.js";
import { PaneNotice, usePaneNotice } from "../pane-notice.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Boxes,
  FolderGit2,
  Globe,
  Package,
  Puzzle,
  RotateCw,
  Upload,
} from "lucide-react";
import type { GithubBatchInstallResult } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js";
import { SettingsPaneHeader } from "../pane-layout.js";
import {
  getDesktopInfo,
  hasElectronIpc,
  reloadServerAndWait,
} from "@/lib/desktop-bridge.js";
import {
  installCollectionZip,
  installPackage,
  listPackageInstallations,
  listInstalledPlugins,
  uninstallPlugin,
  type InstallKind,
  type InstallResult,
} from "@/services/api.js";
import { PackageValidationZip } from "./PackageValidation.js";
import { InstalledPackageRow } from "./InstalledPackageRow.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { useSessionActions } from "@/stores/session-store.js";
import { StImportCard } from "./StImportCard.js";
import { TrustedSourcesCard } from "./TrustedSourcesCard.js";
import { GithubCollectionInstaller } from "./GithubCollectionInstaller.js";
import type { PluginInstallation, PluginSummary } from "@covel/shared";
import { ignoreError } from "@/lib/ignore-error.js";

type PackagesTab = "github" | "installed" | "local";
type InstalledKindFilter = "all" | "plugin" | "world";

/**
 * Tabbed workspace for discovering, installing, updating, validating, and
 * removing third-party plugins and worlds.
 */
export function PackagesPane({
  onNavigate,
}: {
  onNavigate?: (nodeId: string) => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { boot } = useSessionActions();
  const [activeTab, setActiveTab] = useState<PackagesTab>("github");
  const [installedQuery, setInstalledQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<InstalledKindFilter>("all");
  const [busy, setBusy] = useState<UploadKind | null>(null);
  const { notice, show: flash } = usePaneNotice();
  const [lastResult, setLastResult] = useState<InstallResult | null>(null);
  const [installed, setInstalled] = useState<PluginSummary[]>([]);
  const [installations, setInstallations] = useState<
    PluginInstallation[] | null
  >(null);
  const [worldInstallations, setWorldInstallations] = useState<
    PluginInstallation[]
  >([]);
  const [githubBusy, setGithubBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [zipAccepted, setZipAccepted] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const isDesktop = hasElectronIpc();
  const [desktopInfo, setDesktopInfo] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; isDev: boolean }
  >({ status: "loading" });
  const [desktopInfoAttempt, setDesktopInfoAttempt] = useState(0);

  const refreshInstalled = useCallback(async () => {
    try {
      const [plugins, disk, worlds] = await Promise.all([
        listInstalledPlugins({ silentErrors: true }),
        listPackageInstallations().catch(() => null),
        listPackageInstallations("world").catch(() => []),
      ]);
      setInstallations(disk);
      setWorldInstallations(worlds);
      // Only third-party (non-builtin) plugins can be uninstalled.
      setInstalled(plugins.filter((plugin) => plugin.source !== "builtin"));
    } catch {
      /* non-fatal — the list just stays as-is */
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    getDesktopInfo()
      .then((info) => {
        if (cancelled) return;
        setDesktopInfo(
          info ? { status: "ready", isDev: info.isDev } : { status: "error" },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        ignoreError("load desktop restart info")(error);
        setDesktopInfo({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, desktopInfoAttempt]);

  // Boot fetches the world list again and drops the cached full records, so
  // the home screen and the getting-ready screen show what was just installed.
  const refreshWorlds = useCallback(() => void boot(), [boot]);

  /** The status line shows one package; prefer one that needs the restart. */
  function showBatch(result: GithubBatchInstallResult): InstallResult | null {
    const shown =
      result.installed.find((item) => item.kind === "plugin") ??
      result.installed.at(-1);
    if (!shown) return null;
    const single = {
      ok: true as const,
      ...shown,
      restartRequired: shown.kind === "plugin",
    };
    setLastResult(single);
    return single;
  }

  async function uploadZip(kind: UploadKind, file: File) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      flash({ message: t("settings.packages.invalidFileType"), tone: "error" });
      return;
    }
    setBusy(kind);
    setLastResult(null);
    try {
      let result: InstallResult;
      if (kind === "collection") {
        const batch = await installCollectionZip(file);
        const shown = showBatch(batch);
        if (!shown) {
          flash({
            tone: "success",
            message: t("settings.packages.nothingInstalled"),
          });
          return;
        }
        // One message for the whole set.
        result = {
          ...shown,
          id: batch.installed.map((item) => item.id).join(", "),
          restartRequired: batch.restartRequired,
        };
      } else {
        result = await installPackage(kind, file);
        setLastResult(result);
      }
      await refreshInstalled();
      if (kind !== "plugin") refreshWorlds();
      flash({
        message: result.restartRequired
          ? t("settings.packages.installedRestart", { id: result.id })
          : t("settings.packages.installed", { id: result.id }),
        tone: "success",
      });
    } catch (err) {
      flash({
        message:
          err instanceof Error
            ? err.message
            : t("settings.packages.uploadFailed"),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(id: string) {
    if (
      !(await requestConfirm({
        title: t("settings.packages.uninstall"),
        message: t("settings.packages.uninstallConfirm"),
        subject: id,
        confirmLabel: t("settings.packages.uninstall"),
        cancelLabel: t("common.cancel"),
        destructive: true,
      }))
    )
      return;
    setRemoving(id);
    try {
      await uninstallPlugin(id);
      flash({
        message: t("settings.packages.uninstalledRestart", { id }),
        tone: "success",
      });
      // Uninstall takes effect after a restart, same as install.
      setLastResult({ ok: true, kind: "plugin", id, restartRequired: true });
      await refreshInstalled();
    } catch (err) {
      flash({
        message:
          err instanceof Error
            ? err.message
            : t("settings.packages.uninstallFailed", "Uninstall failed"),
        tone: "error",
      });
    } finally {
      setRemoving(null);
    }
  }

  const rows = useMemo(
    () =>
      installations === null
        ? installed.map((plugin) => ({
            id: plugin.id,
            version: plugin.version ?? null,
            source: null,
            pendingUpdate: null,
            integrity: "no-receipt" as const,
            trustedSource: false,
          }))
        : installations,
    [installations, installed],
  );

  const installedById = useMemo(
    () => new Map(installed.map((plugin) => [plugin.id, plugin] as const)),
    [installed],
  );

  const installedPluginIds = useMemo(
    () =>
      new Set([
        ...installed.map((plugin) => plugin.id),
        ...(installations ?? []).map((item) => item.id),
      ]),
    [installed, installations],
  );
  const installedWorldIds = useMemo(
    () => new Set(worldInstallations.map((item) => item.id)),
    [worldInstallations],
  );

  const totalInstalledCount = rows.length + worldInstallations.length;
  const hasBothKinds = rows.length > 0 && worldInstallations.length > 0;
  const installedKindFilter = hasBothKinds ? kindFilter : "all";
  const normalizedInstalledQuery = installedQuery.trim().toLowerCase();

  const matchesQuery = (item: PluginInstallation, name?: string) =>
    !normalizedInstalledQuery ||
    [item.id, name, item.version, item.source?.repository, item.source?.path]
      .join(" ")
      .toLowerCase()
      .includes(normalizedInstalledQuery);
  const visibleGroups = (
    [
      {
        kind: "plugin",
        title: t("settings.packages.installedTitle"),
        items: rows,
      },
      {
        kind: "world",
        title: t("settings.worldGithub.installed"),
        items: worldInstallations,
      },
    ] as const
  )
    .filter(
      ({ kind }) =>
        installedKindFilter === "all" || kind === installedKindFilter,
    )
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        const summary =
          group.kind === "plugin" ? installedById.get(item.id) : undefined;
        const name =
          resolveDisplayText(summary?.displayName, locale) || item.id;
        return matchesQuery(item, name) ? [{ item, summary, name }] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);

  const anyBusy = !!busy || !!removing || githubBusy || updateBusy;
  const openProxySettings = onNavigate
    ? () => onNavigate("desktop")
    : undefined;

  return (
    <div className="space-y-5">
      <SettingsPaneHeader
        title={t("settings.packages.title")}
        description={t("settings.packages.description")}
      />

      <PaneNotice notice={notice} />

      {(lastResult?.restartRequired ||
        installations?.some((item) => item.pendingUpdate) ||
        worldInstallations.some((item) => item.pendingUpdate)) && (
        <div className="flex items-start gap-3 rounded-lg border border-(--accent-warning)/30 bg-(--accent-warning)/10 px-3 py-2.5 text-xs text-(--accent-warning)">
          <div className="flex-1">
            {t(
              !isDesktop
                ? "settings.packages.restartHint"
                : desktopInfo.status === "loading"
                  ? "settings.packages.restartInfoLoading"
                  : desktopInfo.status === "error"
                    ? "settings.packages.restartInfoFailed"
                    : desktopInfo.isDev
                      ? "settings.desktopRestartDevHint"
                      : "settings.packages.restartHint",
            )}
          </div>
          {isDesktop && desktopInfo.status === "error" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              onClick={() => {
                setDesktopInfo({ status: "loading" });
                setDesktopInfoAttempt((attempt) => attempt + 1);
              }}
            >
              {t("common.retry")}
            </Button>
          )}
          {isDesktop && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 border-(--accent-warning)/40 text-xs hover:border-(--accent-warning)"
              disabled={desktopInfo.status !== "ready" || desktopInfo.isDev}
              onClick={() => {
                if (desktopInfo.status !== "ready" || desktopInfo.isDev) return;
                void reloadServerAndWait({
                  message: t("reload.reloadingServer", "Restarting backend…"),
                }).catch((err) =>
                  flash({
                    message:
                      err instanceof Error
                        ? err.message
                        : t("settings.packages.reloadFailed", "Reload failed"),
                    tone: "error",
                  }),
                );
              }}
            >
              <RotateCw className="mr-1.5 h-3 w-3" />
              {t("settings.packages.restartNow")}
            </Button>
          )}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PackagesTab)}
      >
        <div className="ui-workspace-rule">
          <TabsList
            aria-label={t("settings.packages.tabsLabel", "Package sections")}
            className="grid h-auto w-full grid-cols-3 gap-1 bg-transparent p-0 @lg:flex @lg:w-auto @lg:justify-start @lg:gap-3"
          >
            <TabsTrigger
              value="github"
              className="ui-tab-item min-w-0 gap-1.5 px-2 whitespace-normal wrap-break-word data-[state=active]:shadow-none @lg:px-3"
            >
              <FolderGit2 className="hidden size-3.5 shrink-0 @lg:block" />
              <span>{t("settings.packages.tabGithub")}</span>
            </TabsTrigger>
            <TabsTrigger
              value="installed"
              className="ui-tab-item min-w-0 gap-1.5 px-2 whitespace-normal wrap-break-word data-[state=active]:shadow-none @lg:px-3"
            >
              <Package className="hidden size-3.5 shrink-0 @lg:block" />
              <span>{t("settings.packages.tabInstalled")}</span>
              <Badge
                aria-hidden="true"
                variant={totalInstalledCount > 0 ? "secondary" : "outline"}
                className="h-4 px-1.5 text-[10px] tabular-nums"
              >
                {totalInstalledCount}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="local"
              className="ui-tab-item min-w-0 gap-1.5 px-2 whitespace-normal wrap-break-word data-[state=active]:shadow-none @lg:px-3"
            >
              <Upload className="hidden size-3.5 shrink-0 @lg:block" />
              <span>{t("settings.packages.tabLocal")}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          forceMount
          value="github"
          hidden={activeTab !== "github"}
          className="mt-5 space-y-5 data-[state=inactive]:hidden"
        >
          <GithubCollectionInstaller
            disabled={anyBusy}
            onBusyChange={setGithubBusy}
            installedPluginIds={installedPluginIds}
            installedWorldIds={installedWorldIds}
            onOpenProxySettings={openProxySettings}
            onInstalled={(result) => {
              showBatch(result);
              void refreshInstalled();
              refreshWorlds();
            }}
          />
        </TabsContent>

        <TabsContent
          forceMount
          value="installed"
          hidden={activeTab !== "installed"}
          className="mt-5 space-y-5 data-[state=inactive]:hidden"
        >
          {totalInstalledCount === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/30 px-6 py-10 text-center">
              <Package className="h-6 w-6 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {t("settings.packages.installedEmptyTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.packages.installedEmptyHint")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setActiveTab("github")}
              >
                <FolderGit2 className="mr-1.5 h-3.5 w-3.5" />
                {t("settings.packages.tabGithub")}
              </Button>
            </div>
          ) : (
            <>
              {(totalInstalledCount > 1 || installedQuery) && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-2.5">
                  <SettingsListSearch
                    label={t("settings.packages.searchInstalled")}
                    value={installedQuery}
                    onChange={setInstalledQuery}
                  />
                  {hasBothKinds && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(
                        [
                          {
                            id: "all",
                            label: t("settings.github.filterAll", {
                              count: totalInstalledCount,
                            }),
                          },
                          {
                            id: "plugin",
                            label: `${t("settings.github.kindPlugin")} (${rows.length})`,
                          },
                          {
                            id: "world",
                            label: `${t("settings.github.kindWorld")} (${worldInstallations.length})`,
                          },
                        ] as const
                      ).map((pill) => (
                        <SettingsListFilter
                          key={pill.id}
                          active={installedKindFilter === pill.id}
                          onClick={() => setKindFilter(pill.id)}
                          label={pill.label}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {visibleGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/30 px-4 py-8 text-center">
                  <p className="text-xs text-muted-foreground">
                    {t("settings.github.noMatchingPackages")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      setInstalledQuery("");
                      setKindFilter("all");
                    }}
                  >
                    {t("settings.github.resetFilters")}
                  </Button>
                </div>
              ) : (
                visibleGroups.map(({ kind, title, items }) => (
                  <section key={kind} className="space-y-2">
                    <h3 className="settings-section-title flex items-baseline gap-2">
                      {title}
                      <span
                        aria-hidden="true"
                        className="text-xs font-normal text-muted-foreground tabular-nums"
                      >
                        {items.length}
                      </span>
                    </h3>
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card/40">
                      {items.map(({ item, name, summary }) => (
                        <InstalledPackageRow
                          key={item.id}
                          kind={kind}
                          installation={item}
                          name={name}
                          summary={summary}
                          disabled={anyBusy}
                          removing={removing === item.id && kind === "plugin"}
                          onUninstall={
                            kind === "plugin"
                              ? () => void uninstall(item.id)
                              : undefined
                          }
                          onUpdateBusy={setUpdateBusy}
                          onRefresh={() => void refreshInstalled()}
                          onUpdated={() => {
                            void refreshInstalled();
                            if (kind === "world") refreshWorlds();
                          }}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </>
          )}
        </TabsContent>

        <TabsContent
          forceMount
          value="local"
          hidden={activeTab !== "local"}
          className="mt-5 space-y-5 data-[state=inactive]:hidden"
        >
          <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
            <div className="space-y-1">
              <h3 className="settings-section-title flex items-center gap-1.5">
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                {t("settings.packages.localZipTitle")}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settings.packages.localZipHint")}
              </p>
            </div>

            <label className="flex items-start gap-2 rounded-md border border-(--accent-warning)/30 bg-(--accent-warning)/5 p-2.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 accent-primary"
                checked={zipAccepted}
                disabled={!!busy || githubBusy || updateBusy}
                onChange={(event) => setZipAccepted(event.target.checked)}
              />
              <span className="leading-relaxed">
                {t("settings.github.zipRisk")}
              </span>
            </label>

            <div className="grid gap-3 @2xl:grid-cols-3">
              <DropZone
                kind="plugin"
                icon={<Puzzle className="h-4 w-4 text-muted-foreground" />}
                label={t("settings.packages.pluginLabel")}
                hint={t("settings.packages.pluginHint")}
                busy={busy === "plugin"}
                disabled={!zipAccepted || anyBusy}
                onFile={(f) => uploadZip("plugin", f)}
              />
              <DropZone
                kind="collection"
                icon={<Boxes className="h-4 w-4 text-muted-foreground" />}
                label={t("settings.packages.collectionLabel")}
                hint={t("settings.packages.collectionHint")}
                busy={busy === "collection"}
                disabled={!zipAccepted || anyBusy}
                onFile={(f) => uploadZip("collection", f)}
              />
              <DropZone
                kind="world"
                icon={<Globe className="h-4 w-4 text-muted-foreground" />}
                label={t("settings.packages.worldLabel")}
                hint={t("settings.packages.worldHint")}
                busy={busy === "world"}
                disabled={anyBusy}
                onFile={(f) => uploadZip("world", f)}
              />
            </div>
          </section>

          <StImportCard
            busy={anyBusy}
            onBusyChange={setGithubBusy}
            onImported={() => {
              void refreshInstalled();
              refreshWorlds();
            }}
          />

          <PackageValidationZip disabled={anyBusy} />

          <TrustedSourcesCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A collection ZIP installs plugins and worlds together. */
type UploadKind = InstallKind | "collection";

interface DropZoneProps {
  kind: UploadKind;
  icon: React.ReactNode;
  label: string;
  hint: string;
  busy: boolean;
  disabled?: boolean;
  onFile: (file: File) => void;
}

function DropZone({
  kind,
  icon,
  label,
  hint,
  busy,
  disabled = false,
  onFile,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const { t } = useTranslation();

  return (
    <label
      className={
        "flex cursor-pointer flex-col items-center justify-between gap-2.5 rounded-lg border border-dashed px-3.5 py-4 text-center transition-colors " +
        (active
          ? "border-primary bg-primary/5"
          : "border-border bg-background/60 hover:border-primary/60 hover:bg-muted/30") +
        (disabled ? " opacity-60" : "")
      }
      onDragEnter={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !disabled) onFile(file);
      }}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-foreground">
          {icon}
          {label}
        </div>
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        type="button"
        className="h-7 px-2.5 text-xs"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          inputRef.current?.click();
        }}
      >
        <Upload className="mr-1.5 h-3 w-3" />
        {busy
          ? t("settings.packages.uploading")
          : t("settings.packages.chooseFile")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        data-testid={`install-${kind}-file-input`}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </label>
  );
}
