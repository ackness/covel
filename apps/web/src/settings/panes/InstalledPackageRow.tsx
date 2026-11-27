import { useTranslation } from "react-i18next";
import { ExternalLink, Trash2 } from "lucide-react";
import type { PluginInstallation, PluginSummary } from "@covel/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { PackageCredits } from "@/components/shared/package-credits.js";
import { PluginLoadWarnings } from "@/components/shared/plugin-load-warnings.js";
import { pluginPackageInfo } from "@/lib/package-info.js";
import { GithubPackageUpdater } from "./GithubPackageUpdater.js";
import { PackageValidationButton } from "./PackageValidation.js";

export function InstalledPackageRow({
  kind,
  installation,
  name,
  summary,
  disabled,
  removing,
  onUninstall,
  onUpdateBusy,
  onRefresh,
  onUpdated,
}: {
  kind: "plugin" | "world";
  installation: PluginInstallation;
  name: string;
  summary?: PluginSummary;
  disabled: boolean;
  removing: boolean;
  onUninstall?: () => void;
  onUpdateBusy: (busy: boolean) => void;
  onRefresh: () => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const { id, version, source, integrity, trustedSource } = installation;
  const info = summary ? pluginPackageInfo(summary) : undefined;
  return (
    <li className="min-w-0 space-y-2.5 px-3.5 py-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h4 className="min-w-0 wrap-break-word text-sm font-semibold">
          {name}
        </h4>
        {name !== id && (
          <span className="wrap-break-word font-mono text-muted-foreground">
            {id}
          </span>
        )}
        {version && (
          <span className="font-mono text-muted-foreground">v{version}</span>
        )}
        {source && (
          <a
            className="inline-flex min-w-0 items-center gap-1 text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
            href={`${source.repository}/tree/${source.commit}${source.path ? `/${source.path}` : ""}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="wrap-break-word">
              {source.repository.replace("https://github.com/", "")} ·{" "}
              {source.commit.slice(0, 7)}
            </span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        )}
        {trustedSource && (
          <Badge variant="outline">{t("settings.trustedSources.badge")}</Badge>
        )}
        {kind === "plugin" && !summary && (
          <span className="text-(--accent-warning)">
            {t("settings.github.pending")}
          </span>
        )}
      </div>
      {(integrity === "modified" || integrity === "unreadable") && (
        <p className="text-(--accent-warning)">
          {t("settings.trustedSources.modified")}
        </p>
      )}
      <PluginLoadWarnings diagnostics={summary} />
      <GithubPackageUpdater
        kind={kind}
        installation={installation}
        disabled={disabled}
        onBusyChange={onUpdateBusy}
        onUpdated={onUpdated}
        onCancelled={onRefresh}
        extraActions={
          <>
            <PackageValidationButton kind={kind} id={id} disabled={disabled} />
            {onUninstall && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground hover:text-destructive"
                disabled={disabled}
                onClick={onUninstall}
              >
                <Trash2 data-icon="inline-start" />
                {t(
                  removing
                    ? "settings.packages.uninstalling"
                    : "settings.packages.uninstall",
                )}
              </Button>
            )}
          </>
        }
      />
      {info && (info.author || info.license || info.homepage) && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            {t("settings.packages.credits")}
          </summary>
          <PackageCredits
            info={{ ...info, version: undefined }}
            packageName={name}
            className="mt-2"
          />
        </details>
      )}
    </li>
  );
}
