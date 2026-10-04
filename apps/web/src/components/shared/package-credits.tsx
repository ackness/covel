import type { PackageInfo } from "@covel/shared";
import { ExternalLink, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { openPackageLink } from "@/lib/package-info.js";
import { cn } from "@/lib/utils.js";

interface PackageCreditsProps {
  info: PackageInfo | undefined;
  /** Name of the package, named in the warning a link opens through. */
  packageName: string;
  /** Keep the author's message to two lines, for dense lists. */
  compact?: boolean;
  className?: string;
}

/**
 * A package's credits: who made it, its version and license, and the author's
 * message and links. For the surfaces a player sees before play (world and
 * plugin cards, settings); the play view does not show it.
 *
 * All of it is the package author's own text. It is rendered as plain text,
 * and every link opens through `openPackageLink`, which warns first.
 */
export function PackageCredits({
  info,
  packageName,
  compact = false,
  className,
}: PackageCreditsProps) {
  const { t, i18n } = useTranslation();
  if (!info) return null;
  const author = info.author;
  const about = resolveDisplayText(author?.about, i18n.language);
  const links = [
    ...(info.homepage
      ? [{ label: t("package.homepage"), url: info.homepage }]
      : []),
    ...(author?.links ?? []).map((link) => ({
      label: resolveDisplayText(link.label, i18n.language),
      url: link.url,
    })),
  ].filter((link) => link.label);
  if (!author && !info.version && !info.license && links.length === 0)
    return null;
  const open = (url: string) => void openPackageLink(url, packageName, t);

  return (
    <div className={cn("space-y-1.5 text-xs text-muted-foreground", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {author && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <UserRound className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">{t("package.author")}</span>
            {author.url ? (
              <button
                type="button"
                title={author.url}
                onClick={() => open(author.url!)}
                className="truncate font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                {author.name}
              </button>
            ) : (
              <span className="truncate font-medium text-foreground">
                {author.name}
              </span>
            )}
          </span>
        )}
        {info.version && (
          <span className="tabular-nums">
            {t("package.version", { version: info.version })}
          </span>
        )}
        {info.license && (
          <span title={t("package.license")}>{info.license}</span>
        )}
      </div>
      {about && (
        <p
          className={cn(
            "border-l-2 border-border pl-2 leading-relaxed whitespace-pre-line wrap-break-word",
            compact && "line-clamp-2",
          )}
        >
          {about}
        </p>
      )}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {links.map((link) => (
            <button
              key={`${link.url}\n${link.label}`}
              type="button"
              title={link.url}
              onClick={() => open(link.url)}
              className="inline-flex max-w-full items-center gap-1 rounded-(--radius-sm) border border-border px-2 py-0.5 text-foreground transition-colors hover:border-primary/60 hover:text-primary"
            >
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{link.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
