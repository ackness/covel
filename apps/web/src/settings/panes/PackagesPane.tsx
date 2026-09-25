import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package, Upload, Globe, Puzzle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { hasElectronIpc, reloadServerAndWait } from "@/lib/desktop-bridge.js";
import { text } from "@/components/world/editor-helpers.js";
import {
  installPackage,
  listPluginInstallations,
  listInstalledPlugins,
  uninstallPlugin,
  type InstallKind,
  type InstallResult,
} from "@/services/api.js";
import { GithubPluginInstaller } from "./GithubPluginInstaller.js";
import type { PluginInstallation, PluginSummary } from "@covel/shared";

interface ToastState {
  message: string;
  tone: "success" | "error";
}

/**
 * Drag-and-drop install pane for plugin + world .zip packages.
 *
 * Uploads to POST /api/install/{plugin|world}. On success, prompts the user
 * that a server restart is required (plugins only — worlds reload on demand).
 */
export function PackagesPane() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<InstallKind | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [lastResult, setLastResult] = useState<InstallResult | null>(null);
  const [installed, setInstalled] = useState<PluginSummary[]>([]);
  const [installations, setInstallations] = useState<
    PluginInstallation[] | null
  >(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [zipAccepted, setZipAccepted] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const refreshInstalled = useCallback(async () => {
    try {
      const [plugins, disk] = await Promise.all([
        listInstalledPlugins({ silentErrors: true }),
        listPluginInstallations().catch(() => null),
      ]);
      setInstallations(disk);
      // Only third-party (non-builtin) plugins can be uninstalled.
      setInstalled(plugins.filter((plugin) => plugin.source !== "builtin"));
    } catch {
      /* non-fatal — the list just stays as-is */
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  async function uploadZip(kind: InstallKind, file: File) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      flash({ message: t("settings.packages.invalidFileType"), tone: "error" });
      return;
    }
    setBusy(kind);
    setLastResult(null);
    try {
      const result = await installPackage(kind, file);
      setLastResult(result);
      await refreshInstalled();
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

  function flash(state: ToastState) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(state);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 4000);
  }

  const rows =
    installations === null
      ? installed.map((plugin) => ({
          id: plugin.id,
          version: plugin.version ?? null,
          source: null,
        }))
      : installations;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Package className="w-4 h-4" />
          {t("settings.packages.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("settings.packages.description")}
        </p>
      </header>

      {toast && (
        <div
          className={
            "text-xs px-3 py-2 rounded border " +
            (toast.tone === "success"
              ? "bg-primary/10 border-primary/20 text-primary"
              : "bg-destructive/10 border-destructive/20 text-destructive")
          }
        >
          {toast.message}
        </div>
      )}

      {lastResult?.restartRequired && (
        <div className="flex items-start gap-3 text-xs px-3 py-2.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          <div className="flex-1">{t("settings.packages.restartHint")}</div>
          {hasElectronIpc() && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs shrink-0 border-amber-500/40 hover:border-amber-500"
              onClick={() =>
                reloadServerAndWait({
                  message: t("reload.reloadingServer", "Restarting backend…"),
                }).catch((err) =>
                  flash({
                    message:
                      err instanceof Error
                        ? err.message
                        : t("settings.packages.reloadFailed", "Reload failed"),
                    tone: "error",
                  }),
                )
              }
            >
              <RotateCw className="w-3 h-3 mr-1.5" />
              {t("settings.packages.restartNow")}
            </Button>
          )}
        </div>
      )}

      <GithubPluginInstaller
        disabled={!!busy || !!removing}
        onBusyChange={setGithubBusy}
        onInstalled={(result) => {
          setLastResult(result);
          void refreshInstalled();
        }}
      />

      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={zipAccepted}
          disabled={!!busy || githubBusy}
          onChange={(event) => setZipAccepted(event.target.checked)}
        />
        {t("settings.github.zipRisk")}
      </label>
      <DropZone
        kind="plugin"
        icon={<Puzzle className="w-5 h-5" />}
        label={t("settings.packages.pluginLabel")}
        hint={t("settings.packages.pluginHint")}
        busy={busy === "plugin"}
        disabled={!zipAccepted || githubBusy || !!busy}
        onFile={(f) => uploadZip("plugin", f)}
      />

      <DropZone
        kind="world"
        icon={<Globe className="w-5 h-5" />}
        label={t("settings.packages.worldLabel")}
        hint={t("settings.packages.worldHint")}
        busy={busy === "world"}
        disabled={githubBusy || !!busy}
        onFile={(f) => uploadZip("world", f)}
      />

      {rows.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t("settings.packages.installedTitle", "Installed plugins")}
          </h3>
          <ul className="divide-y divide-border border border-border rounded">
            {rows.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">
                    {text(
                      installed.find((plugin) => plugin.id === p.id)
                        ?.displayName,
                    ) || p.id}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground truncate">
                    {p.id}
                    {p.version ? ` · ${p.version}` : ""}
                  </div>
                  {p.source && (
                    <a
                      className="block text-xs underline wrap-break-word"
                      href={`${p.source.repository}/tree/${p.source.commit}/${p.source.path}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {p.source.repository.replace("https://github.com/", "")} ·{" "}
                      {p.source.commit.slice(0, 12)}
                    </a>
                  )}
                  {!installed.some((plugin) => plugin.id === p.id) && (
                    <p className="text-xs text-muted-foreground">
                      {t("settings.github.pending")}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0 text-destructive border-destructive/30 hover:border-destructive"
                  disabled={!!removing || !!busy || githubBusy}
                  onClick={() => void uninstall(p.id)}
                >
                  {removing === p.id
                    ? t("settings.packages.uninstalling", "Removing…")
                    : t("settings.packages.uninstall", "Uninstall")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {lastResult && (
        <div className="text-xs font-mono text-muted-foreground border border-border rounded p-2 space-y-0.5">
          <div>id: {lastResult.id}</div>
          <div>kind: {lastResult.kind}</div>
        </div>
      )}
    </div>
  );
}

interface DropZoneProps {
  kind: InstallKind;
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
        "flex flex-col items-center justify-center gap-2 px-4 py-6 rounded-md border-2 border-dashed cursor-pointer transition-colors " +
        (active
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/60 hover:bg-muted/30") +
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
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </div>
      <div className="text-xs text-muted-foreground text-center">{hint}</div>
      <Button
        size="sm"
        variant="outline"
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          inputRef.current?.click();
        }}
      >
        <Upload className="w-3 h-3 mr-1" />
        {busy
          ? t("settings.packages.uploading")
          : t("settings.packages.chooseFile")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        disabled={disabled}
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && !disabled) onFile(file);
          if (inputRef.current) inputRef.current.value = "";
        }}
        data-testid={`install-${kind}-file-input`}
      />
    </label>
  );
}
