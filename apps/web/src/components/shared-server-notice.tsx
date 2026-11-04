import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { getSharedServerInfo } from "@/services/api/health.js";
import { SHARED_SERVER_DOCS_PAGE, docsPageUrl } from "@/lib/docs-links.js";
import { useNotice } from "@/lib/notice-center.js";

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
 * their saves and API keys go, and which open-source build serves them, as a
 * global card until it is closed. The settings page's key list links to the
 * same documentation page, so the explanation stays reachable afterwards.
 * Closing the card hides it for good, not just into the bell.
 */
export function useSharedServerNotice(): void {
  const { t, i18n } = useTranslation();
  const [info] = useState(getSharedServerInfo);
  const [dismissed, setDismissed] = useState(readDismissed);
  const linkClass =
    "text-primary underline underline-offset-2 hover:text-primary/80";
  useNotice(
    !info || dismissed
      ? null
      : {
          key: "shared-server",
          kind: "card",
          tone: "info",
          scope: "global",
          title: t("sharedServer.title"),
          body: t("sharedServer.body"),
          onDismiss: () => {
            rememberDismissed();
            setDismissed(true);
          },
          render: () => (
            <div className="flex flex-col gap-1 text-xs">
              <p className="flex items-start gap-1.5 font-medium">
                <KeyRound
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                />
                <span>{t("sharedServer.keyAdvice")}</span>
              </p>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
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
          ),
        },
  );
}
