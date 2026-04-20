/**
 * Desktop-only tab for the Settings dialog.
 *
 * Visible only when running inside the Electron shell (detected via
 * `isDesktopApp()`). Exposes paths and actions: open config / data / logs
 * folders, change data_root, restart the backend server, reset onboarding.
 */

import { useEffect, useState } from "react";
import {
  FolderOpen, FileText, RotateCw, Info, Loader2, RefreshCcw, HardDrive, FileCode, KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  isDesktopApp,
  hasElectronIpc,
  getDesktopInfo,
  openLogsDir,
  openConfigDir,
  openDataDir,
  openLlmToml,
  openKeysEnv,
  pickDataDir,
  restartServer,
} from "@/lib/desktop-bridge.js";
import { resetOnboarding } from "@/components/onboarding-wizard.js";

interface DesktopInfo {
  version: string;
  platform: string;
  isDev: boolean;
  covelHome: string;
  dataRoot: string;
  logsDir: string;
  dbPath: string;
  configTomlPath: string;
  llmTomlPath: string;
  keysEnvPath: string;
  serverPort: number;
}

export function DesktopSettingsTab() {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    getDesktopInfo().then((i) => setInfo(i as DesktopInfo | null)).catch(() => {});
  }, []);

  async function refreshInfo() {
    setBusy("refresh");
    try {
      const i = await getDesktopInfo();
      setInfo(i as DesktopInfo | null);
    } finally {
      setBusy(null);
    }
  }

  async function handleRestart() {
    setBusy("restart");
    try {
      const result = await restartServer();
      if (result?.port) setToast(`Server restarted on port ${result.port}`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Restart failed");
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function handlePickDataDir() {
    setBusy("pick");
    try {
      // Electron has a native folder picker; REST-mode desktop (Tauri, self-
      // host) doesn't, so we prompt the user for an absolute path.
      let manualPath: string | undefined;
      if (!hasElectronIpc()) {
        const entered = window.prompt(
          "Enter an absolute path for the new data directory:\n\n" +
            "Examples:\n  /Users/me/Documents/covel\n  /Volumes/External/covel-data\n\n" +
            "Changing this will not move existing data — the new location starts fresh.",
          info?.dataRoot ?? "",
        );
        if (!entered || !entered.trim()) return;
        manualPath = entered.trim();
      }

      const picked = await pickDataDir(manualPath);
      if (picked) {
        setToast(`Data root set to ${picked}. Restart the app to apply.`);
        await refreshInfo();
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Could not change data root");
    } finally {
      setBusy(null);
      setTimeout(() => setToast(null), 5000);
    }
  }

  function handleResetOnboarding() {
    resetOnboarding();
    setToast("Onboarding will show on next launch");
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="space-y-5 mt-0">
      {toast && (
        <div className="text-xs px-3 py-2 rounded bg-primary/10 border border-primary/20 text-primary">
          {toast}
        </div>
      )}

      {/* ── Paths ───────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Data Locations
        </h3>
        <div className="space-y-2 text-xs">
          <InfoRow label="Config" value={info?.covelHome ?? "—"} mono />
          <InfoRow label="Data" value={info?.dataRoot ?? "—"} mono />
          <InfoRow label="Database" value={info?.dbPath ?? "—"} mono />
          <InfoRow label="Logs" value={info?.logsDir ?? "—"} mono />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="outline" onClick={() => openConfigDir()}>
            <FolderOpen className="w-3 h-3 mr-1.5" />
            Open config (~/.covel)
          </Button>
          <Button size="sm" variant="outline" onClick={() => openDataDir()}>
            <FolderOpen className="w-3 h-3 mr-1.5" />
            Open data folder
          </Button>
          <Button size="sm" variant="outline" onClick={() => openLogsDir()}>
            <FileText className="w-3 h-3 mr-1.5" />
            Open logs folder
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handlePickDataDir}
            disabled={busy !== null}
          >
            <HardDrive className="w-3 h-3 mr-1.5" />
            Change data location…
          </Button>
        </div>
      </section>

      {/* ── Editor shortcuts ────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Edit config files
        </h3>
        <div className="text-xs text-muted-foreground">
          Opens in your default editor. Restart Covel after saving for changes
          to take effect.
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => openLlmToml().catch((err) => setToast(String(err)))}
          >
            <FileCode className="w-3 h-3 mr-1.5" />
            Edit llm.toml
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openKeysEnv().catch((err) => setToast(String(err)))}
          >
            <KeyRound className="w-3 h-3 mr-1.5" />
            Edit keys.env
          </Button>
        </div>
      </section>

      {/* ── Server ──────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Backend Server
        </h3>
        <div className="text-xs text-muted-foreground">
          Local API server running on port{" "}
          <span className="font-mono text-foreground">
            {info?.serverPort ?? "?"}
          </span>
          .
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleRestart}
            disabled={busy !== null}
          >
            {busy === "restart" ? (
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
            ) : (
              <RotateCw className="w-3 h-3 mr-1.5" />
            )}
            Restart server
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={refreshInfo}
            disabled={busy !== null}
          >
            <RefreshCcw className="w-3 h-3 mr-1.5" />
            Refresh info
          </Button>
        </div>
      </section>

      {/* ── Tutorial ────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Tutorial
        </h3>
        <div className="text-xs text-muted-foreground">
          Re-run the onboarding wizard the next time Covel launches.
        </div>
        <Button size="sm" variant="outline" onClick={handleResetOnboarding}>
          Reset onboarding
        </Button>
      </section>

      {/* ── About ───────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          About
        </h3>
        <div className="space-y-1 text-xs">
          <InfoRow label="Version" value={info?.version ?? "—"} />
          <InfoRow label="Platform" value={info?.platform ?? "—"} />
          <InfoRow
            label="Mode"
            value={info ? (info.isDev ? "Development" : "Production") : "—"}
          />
        </div>
        <div className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            API keys live in <code className="font-mono">{info?.keysEnvPath ?? "~/.covel/keys.env"}</code> as
            plain text. Protect the file with OS permissions; the app sets
            mode 600 when writing.
          </span>
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-muted-foreground min-w-[80px]">{label}:</span>
      <span
        className={`flex-1 break-all ${mono ? "font-mono text-[11px]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/** Convenience flag so callers can skip rendering the tab entirely in web mode. */
export function isDesktop(): boolean {
  return isDesktopApp();
}
