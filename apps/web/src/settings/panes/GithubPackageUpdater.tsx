import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { GithubPackageRiskConsent } from "./GithubPackageRiskConsent.js";

export function GithubPackageUpdater({
  kind = "plugin",
  installation,
  disabled,
  onBusyChange,
  onUpdated,
  onCancelled,
}: {
  kind?: "plugin" | "world";
  installation: PluginInstallation;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onUpdated: (result: InstallResult) => void;
  onCancelled: () => void;
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
  }, [installation.source?.commit, installation.pendingUpdate]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (!controller.current?.signal.aborted)
        setError(
          error instanceof Error ? error.message : t("settings.github.failed"),
        );
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
  if (!installation.source && !pending)
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.pluginUpdate.untracked")}
      </p>
    );
  return (
    <div className="space-y-2 text-xs">
      {error && (
        <p role="alert" className="text-destructive wrap-break-word">
          {error}
        </p>
      )}
      {pending ? (
        <>
          <p>
            {t("settings.pluginUpdate.pending", {
              version: pending.version ?? pending.source.commit.slice(0, 12),
            })}
          </p>
          {pending.error && (
            <p role="alert" className="text-destructive wrap-break-word">
              {pending.error}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
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
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {installation.source?.tracking.kind === "pinned"
              ? t("settings.pluginUpdate.pinned")
              : t("settings.pluginUpdate.tracking", {
                  ref:
                    installation.source?.tracking.kind === "branch"
                      ? installation.source.tracking.ref
                      : t("settings.pluginUpdate.defaultBranch"),
                })}
          </p>
          <details>
            <summary className="cursor-pointer">
              {t("settings.pluginUpdate.chooseVersion")}
            </summary>
            <label className="mt-2 block">
              {t("settings.pluginUpdate.url")}
              <input
                type="url"
                value={url}
                disabled={disabled || busy}
                className="mt-1 w-full rounded border border-border bg-transparent p-2"
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
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void run(check)}
          >
            {t(
              busy
                ? "settings.pluginUpdate.working"
                : "settings.pluginUpdate.check",
            )}
          </Button>
          {status && (
            <p role="status">{t(`settings.pluginUpdate.${status}`)}</p>
          )}
          {preview && (
            <div className="space-y-2 wrap-break-word">
              <p className="font-semibold">
                {preview.previous.version ??
                  preview.previous.source.commit.slice(0, 12)}{" "}
                → {preview.version ?? preview.source.commit.slice(0, 12)}
              </p>
              <a
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
                href={`${preview.source.repository}/compare/${preview.previous.source.commit}...${preview.source.commit}`}
              >
                {t("settings.pluginUpdate.compare")}
              </a>
              <p className="font-mono">{preview.source.commit}</p>
              <details>
                <summary className="cursor-pointer">
                  {t("settings.pluginUpdate.files", {
                    added: preview.changes.added.length,
                    modified: preview.changes.modified.length,
                    removed: preview.changes.removed.length,
                  })}
                </summary>
                <ul className="mt-1 max-h-48 overflow-y-auto font-mono">
                  {(["added", "modified", "removed"] as const).flatMap((kind) =>
                    preview.changes[kind].map((file) => (
                      <li key={`${kind}:${file}`}>
                        {kind === "added"
                          ? "+"
                          : kind === "removed"
                            ? "−"
                            : "~"}{" "}
                        {file}
                      </li>
                    )),
                  )}
                </ul>
              </details>
              <p>{t("settings.pluginUpdate.explain")}</p>
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
