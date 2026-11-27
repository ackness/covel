import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type {
  GithubPluginUpdatePreview,
  PluginInstallation,
} from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import {
  cancelGithubPackageUpdate,
  checkGithubPackageUpdate,
  updateGithubPackage,
  type InstallResult,
} from "@/services/api.js";
import { PluginCapabilitiesPreview } from "./PluginCapabilitiesPreview.js";
import { GithubPackageRiskConsent } from "./GithubPackageRiskConsent.js";

export function GithubPackageUpdater({
  kind = "plugin",
  installation,
  disabled,
  onBusyChange,
  onUpdated,
  onCancelled,
  extraActions,
}: {
  kind?: "plugin" | "world";
  installation: PluginInstallation;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onUpdated: (result: InstallResult) => void;
  onCancelled: () => void;
  extraActions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<GithubPluginUpdatePreview | null>(
    null,
  );
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"current" | "pinned" | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    setPreview(null);
    setAccepted(false);
    setStatus(null);
    setError(null);
  }, [installation.source?.commit, installation.pendingUpdate]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (!controller.current?.signal.aborted) {
        setError(
          err instanceof Error ? err.message : t("settings.github.failed"),
        );
      }
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  async function check() {
    setPreview(null);
    setAccepted(false);
    setStatus(null);
    controller.current = new AbortController();
    const result = await checkGithubPackageUpdate(
      installation.id,
      url.trim() || undefined,
      controller.current.signal,
      kind,
    );
    if (controller.current.signal.aborted) return;
    if (result.status === "available") setPreview(result.preview);
    else setStatus(result.status);
  }

  const pending = installation.pendingUpdate;
  if (!installation.source && !pending) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {extraActions}
        <span className="text-muted-foreground">
          {t("settings.pluginUpdate.untracked")}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-xs">
      {error && (
        <p role="alert" className="text-destructive wrap-break-word">
          {error}
        </p>
      )}
      {pending ? (
        <div className="space-y-2 rounded-md border border-(--accent-warning)/30 bg-(--accent-warning)/5 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-foreground">
              {t("settings.pluginUpdate.pending", {
                version: pending.version ?? pending.source.commit.slice(0, 12),
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={disabled || busy}
                onClick={() =>
                  void run(async () => {
                    await cancelGithubPackageUpdate(installation.id, kind);
                    onCancelled();
                  })
                }
              >
                {t("settings.pluginUpdate.cancel")}
              </Button>
              {extraActions}
            </div>
          </div>
          {pending.error && (
            <p role="alert" className="text-destructive wrap-break-word">
              {pending.error}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={disabled || busy}
              onClick={() => void run(check)}
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t(
                busy
                  ? "settings.pluginUpdate.working"
                  : "settings.pluginUpdate.check",
              )}
            </Button>
            <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              {installation.source?.tracking.kind === "pinned"
                ? t("settings.pluginUpdate.pinned")
                : t("settings.pluginUpdate.tracking", {
                    ref:
                      installation.source?.tracking.kind === "branch"
                        ? installation.source.tracking.ref
                        : t("settings.pluginUpdate.defaultBranch"),
                  })}
            </span>
            {status && (
              <span
                role="status"
                className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
              >
                {t(`settings.pluginUpdate.${status}`)}
              </span>
            )}
            {extraActions}
          </div>

          <details className="group text-[11px]">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              {t("settings.pluginUpdate.chooseVersion")}
            </summary>
            <label className="mt-2 block text-xs text-muted-foreground">
              {t("settings.pluginUpdate.url")}
              <input
                type="url"
                value={url}
                disabled={disabled || busy}
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary"
                placeholder={`${installation.source?.repository}/tree/<tag-or-commit>/${installation.source?.path}`}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setPreview(null);
                  setAccepted(false);
                  setStatus(null);
                  setError(null);
                }}
              />
            </label>
          </details>

          {preview && (
            <div className="space-y-2.5 rounded-md border border-primary/30 bg-primary/5 p-3 wrap-break-word">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-foreground">
                  {preview.previous.version ??
                    preview.previous.source.commit.slice(0, 12)}{" "}
                  → {preview.version ?? preview.source.commit.slice(0, 12)}
                </p>
                <a
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                  href={`${preview.source.repository}/compare/${preview.previous.source.commit}...${preview.source.commit}`}
                >
                  {t("settings.pluginUpdate.compare")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                {preview.source.commit}
              </p>
              <details className="rounded border border-border bg-background/60 p-2">
                <summary className="cursor-pointer font-medium text-foreground">
                  {t("settings.pluginUpdate.files", {
                    added: preview.changes.added.length,
                    modified: preview.changes.modified.length,
                    removed: preview.changes.removed.length,
                  })}
                </summary>
                <ul className="mt-1.5 max-h-48 overflow-y-auto font-mono text-[11px]">
                  {(["added", "modified", "removed"] as const).flatMap(
                    (changeKind) =>
                      preview.changes[changeKind].map((file) => (
                        <li key={`${changeKind}:${file}`}>
                          {changeKind === "added"
                            ? "+"
                            : changeKind === "removed"
                              ? "−"
                              : "~"}{" "}
                          {file}
                        </li>
                      )),
                  )}
                </ul>
              </details>
              <p className="text-muted-foreground">
                {t("settings.pluginUpdate.explain")}
              </p>
              {kind === "plugin" && (
                <PluginCapabilitiesPreview preview={preview} update />
              )}
              <GithubPackageRiskConsent
                kind={kind}
                hasServerCode={preview.hasServerCode}
                accepted={accepted}
                disabled={disabled || busy}
                onChange={setAccepted}
              />
              <Button
                size="sm"
                disabled={disabled || busy || !accepted}
                onClick={() =>
                  void run(async () => {
                    const result = await updateGithubPackage(
                      preview.token,
                      kind,
                    );
                    setPreview(null);
                    setAccepted(false);
                    onUpdated(result);
                  })
                }
              >
                {t("settings.pluginUpdate.confirm")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
