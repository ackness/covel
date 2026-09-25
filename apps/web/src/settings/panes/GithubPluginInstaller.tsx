import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GithubPluginPreview } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import {
  previewGithubPlugins,
  installGithubPlugin,
  type InstallResult,
} from "@/services/api.js";

export function GithubPluginInstaller({
  onInstalled,
  disabled = false,
  onBusyChange,
}: {
  onInstalled: (result: InstallResult, preview: GithubPluginPreview) => void;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [items, setItems] = useState<GithubPluginPreview[]>([]);
  const [selected, setSelected] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const preview = items[selected];

  async function inspect() {
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("preview");
    onBusyChange(true);
    setItems([]);
    setAccepted(false);
    setError(null);
    try {
      const result = await previewGithubPlugins(url.trim(), controller.signal);
      if (!controller.signal.aborted) {
        setItems(result.items);
        setSelected(0);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error ? err.message : t("settings.github.failed"),
        );
    } finally {
      if (requestRef.current === controller) {
        setBusy(null);
        onBusyChange(false);
        requestRef.current = null;
      }
    }
  }

  async function install() {
    if (!preview || !accepted) return;
    setBusy("install");
    onBusyChange(true);
    setError(null);
    try {
      const result = await installGithubPlugin(preview.token);
      onInstalled(result, preview);
      setItems([]);
      setAccepted(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.github.failed"),
      );
    } finally {
      setBusy(null);
      onBusyChange(false);
    }
  }

  return (
    <section className="space-y-3 rounded border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("settings.github.title")}</h3>
        <a
          className="text-xs underline"
          href="https://github.com/covel-ai/covel-plugins"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("settings.github.browse")}
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.github.description")}
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label className="min-w-0 flex-1 text-xs" htmlFor="github-plugin-url">
          {t("settings.github.url")}
          <input
            id="github-plugin-url"
            type="url"
            required
            value={url}
            disabled={disabled || !!busy}
            placeholder="https://github.com/author/plugin"
            className="mt-1 w-full rounded border border-border bg-transparent p-2 text-sm"
            onChange={(event) => {
              setUrl(event.target.value);
              setItems([]);
              setAccepted(false);
              setError(null);
            }}
          />
        </label>
        <Button
          type="submit"
          className="self-end"
          size="sm"
          disabled={disabled || !!busy || !url.trim()}
        >
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
            className="self-end"
            onClick={() => requestRef.current?.abort()}
          >
            {t("settings.github.cancel")}
          </Button>
        )}
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive wrap-break-word">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-3 text-xs">
          {items.length > 1 && (
            <label className="block">
              {t("settings.github.choose")}
              <select
                className="mt-1 w-full rounded border border-border bg-background p-2"
                value={selected}
                disabled={!!busy}
                onChange={(event) => {
                  setSelected(Number(event.target.value));
                  setAccepted(false);
                }}
              >
                {items.map((item, i) => (
                  <option key={item.source.path} value={i}>
                    {item.id} ({item.source.path || "/"})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="space-y-1 wrap-break-word">
            <p className="font-semibold">
              {preview.id}
              {preview.version ? ` · ${preview.version}` : ""}
            </p>
            {preview.description && <p>{preview.description}</p>}
            <p>
              <a
                href={`${preview.source.repository}/tree/${preview.source.commit}/${preview.source.path}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {preview.source.repository}
                {preview.source.path ? ` / ${preview.source.path}` : ""}
              </a>
            </p>
            <p className="font-mono">{preview.source.commit}</p>
          </div>
          <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-semibold">{t("settings.github.riskTitle")}</p>
            <p>
              {t(
                preview.hasServerCode
                  ? "settings.github.codeRisk"
                  : "settings.github.contentRisk",
              )}
            </p>
            <p>{t("settings.github.targetRisk")}</p>
            <p>{t("settings.github.indexRisk")}</p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={accepted}
                disabled={!!busy}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              {t("settings.github.accept")}
            </label>
          </div>
          <Button
            size="sm"
            disabled={!accepted || !!busy || disabled}
            onClick={() => void install()}
          >
            {t(
              busy === "install"
                ? "settings.github.installing"
                : "settings.github.install",
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
