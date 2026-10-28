import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, ShieldCheck, X } from "lucide-react";
import { getSharedServerInfo } from "@/services/api/health.js";
import { SHARED_SERVER_DOCS_PAGE, docsPageUrl } from "@/lib/docs-links.js";

const DISMISSED_KEY = "covel:sharedServerNoticeDismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Private windows and blocked storage: the notice returns next visit.
  }
}

/** A link to the exact commit on GitHub; the repository itself elsewhere. */
function sourceHref(repository: string, commit: string | undefined): string {
  if (!commit) return repository;
  try {
    return new URL(repository).hostname === "github.com"
      ? `${repository}/tree/${commit}`
      : repository;
  } catch {
    return repository;
  }
}

/**
 * Tells players on a shared server that keeps saves in their browser where
 * their saves and API keys go, and which open-source build serves them. The
 * settings page's key list links to the same documentation page, so the
 * explanation stays reachable after the notice is dismissed.
 */
export function SharedServerNotice() {
  const { t, i18n } = useTranslation();
  const [info] = useState(getSharedServerInfo);
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!info || dismissed) return null;

  const linkClass =
    "text-primary underline underline-offset-2 hover:text-primary/80";
  return (
    <aside
      aria-label={t("sharedServer.title")}
      className="relative z-10 shrink-0 border-b border-primary/20 bg-primary/5 px-4 py-2.5 text-foreground"
    >
      <div className="mx-auto flex max-w-5xl items-start gap-3">
        <ShieldCheck
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1 text-xs leading-relaxed">
          <p className="text-sm font-medium">{t("sharedServer.title")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {t("sharedServer.body")}
          </p>
          <p className="mt-1 flex items-start gap-1.5 font-medium">
            <KeyRound
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
            />
            <span>{t("sharedServer.keyAdvice")}</span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <a
              href={docsPageUrl(SHARED_SERVER_DOCS_PAGE, i18n.language)}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {t("sharedServer.learnMore")}
            </a>
            {info.repository && (
              <a
                href={sourceHref(info.repository, info.commit)}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                {info.commit
                  ? t("sharedServer.sourceAt", {
                      commit: info.commit.slice(0, 7),
                    })
                  : t("sharedServer.source")}
              </a>
            )}
          </p>
        </div>
        <button
          type="button"
          aria-label={t("sharedServer.dismiss")}
          onClick={() => {
            rememberDismissed();
            setDismissed(true);
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}
