import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GithubBatchInstallResult,
  GithubCollectionPreview,
} from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  installGithubPackages,
  previewGithubCollection,
} from "@/services/api.js";
import { GithubPackageRiskConsent } from "./GithubPackageRiskConsent.js";

/**
 * One GitHub install flow for plugins, worlds and collections. The link is
 * previewed once, the user ticks what to install, consents once, and the
 * selection is installed as a unit: all of it or none of it.
 */
export function GithubCollectionInstaller({
  onInstalled,
  disabled = false,
  onBusyChange,
}: {
  onInstalled: (result: GithubBatchInstallResult) => void;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<GithubCollectionPreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const items = preview?.items ?? [];
  const chosen = useMemo(
    () => items.filter((item) => selected.has(item.token)),
    [items, selected],
  );
  // An error about one package blocks only a selection that contains it; an
  // error about the set as a whole (a host version range) blocks everything.
  const blocked = (preview?.problems ?? []).some(
    (problem) =>
      problem.level === "error" &&
      (!problem.packageId ||
        chosen.some((item) => item.id === problem.packageId)),
  );

  function reset() {
    setPreview(null);
    setSelected(new Set());
    setAccepted(false);
    setError(null);
  }

  async function inspect() {
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("preview");
    onBusyChange(true);
    reset();
    try {
      const result = await previewGithubCollection(
        url.trim(),
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPreview(result);
        setSelected(new Set(result.items.map((item) => item.token)));
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
    if (!preview || chosen.length === 0 || !accepted || blocked) return;
    setBusy("install");
    onBusyChange(true);
    setError(null);
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
        <span className="flex flex-wrap gap-3 text-xs">
          <a
            className="underline"
            href="https://github.com/covel-ai/covel-plugins"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("settings.github.browse")}
          </a>
          <a
            className="underline"
            href="https://github.com/covel-ai/covel-worlds"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("settings.github.browseWorlds")}
          </a>
        </span>
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
        <label className="min-w-0 flex-1 text-xs" htmlFor="github-package-url">
          {t("settings.github.url")}
          <input
            id="github-package-url"
            type="url"
            required
            value={url}
            disabled={disabled || !!busy}
            placeholder="https://github.com/author/repository"
            className="mt-1 w-full rounded border border-border bg-transparent p-2 text-sm"
            onChange={(event) => {
              setUrl(event.target.value);
              reset();
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
      {preview && items.length > 0 && (
        <div className="space-y-3 text-xs">
          {preview.collection && (
            <p className="font-semibold">
              {t("settings.github.collection", {
                name:
                  resolveDisplayText(preview.collection.name, i18n.language) ||
                  preview.collection.id,
              })}
              {preview.collection.version
                ? ` · ${preview.collection.version}`
                : ""}
              {preview.collection.author
                ? ` · ${preview.collection.author}`
                : ""}
            </p>
          )}
          <p className="text-muted-foreground">
            {t("settings.github.multiple")}
          </p>
          {preview.problems.length > 0 && (
            <ul className="space-y-1" data-testid="github-preview-problems">
              {preview.problems.map((problem, index) => (
                <li
                  key={index}
                  className={`wrap-break-word ${
                    problem.level === "error"
                      ? "text-destructive"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {problem.message}
                </li>
              ))}
            </ul>
          )}
          <ul className="divide-y divide-border rounded border border-border">
            {items.map((item) => (
              <li key={item.token} className="p-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(item.token)}
                    disabled={disabled || !!busy}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(item.token);
                      else next.delete(item.token);
                      setSelected(next);
                      // Consent covers one exact selection.
                      setAccepted(false);
                      setError(null);
                    }}
                  />
                  <span className="min-w-0 space-y-1 wrap-break-word">
                    <span className="block font-semibold">
                      {t(
                        item.kind === "world"
                          ? "settings.github.kindWorld"
                          : "settings.github.kindPlugin",
                      )}
                      {" · "}
                      {item.id}
                      {item.version ? ` · ${item.version}` : ""}
                      {item.hasServerCode
                        ? ` · ${t("settings.github.hasCode")}`
                        : ""}
                    </span>
                    {item.author && (
                      <span className="block text-muted-foreground">
                        {t("package.author")}: {item.author}
                      </span>
                    )}
                    {item.description && (
                      <span className="block">{item.description}</span>
                    )}
                    <a
                      href={`${item.source.repository}/tree/${item.source.commit}/${item.source.path}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block underline"
                    >
                      {item.source.repository}
                      {item.source.path ? ` / ${item.source.path}` : ""}
                    </a>
                    <span className="block font-mono">
                      {item.source.commit}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
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
          <Button
            size="sm"
            disabled={
              chosen.length === 0 || !accepted || blocked || !!busy || disabled
            }
            onClick={() => void install()}
          >
            {busy === "install"
              ? t("settings.github.installing")
              : t("settings.github.installSelected", { count: chosen.length })}
          </Button>
        </div>
      )}
    </section>
  );
}
