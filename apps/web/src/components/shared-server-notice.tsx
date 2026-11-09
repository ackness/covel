import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, KeyRound } from "lucide-react";
import { getSharedServerInfo } from "@/services/api/health.js";
import { SHARED_SERVER_DOCS_PAGE, docsPageUrl } from "@/lib/docs-links.js";
import {
  dismissNotice,
  getNoticeSnapshot,
  subscribeNotices,
  useNotice,
} from "@/lib/notice-center.js";

const NOTICE_KEY = "shared-server";
const COLLAPSED_KEY = "covel:sharedServerNoticeCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, "1");
  } catch {
    // Private windows and blocked storage: the card opens again next visit.
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
 * Warns players on a shared server that keeps saves in their browser: use a
 * temporary API key, and expect saves to live only in this browser. It also
 * says which open-source build serves them. The warning never goes away for
 * good: closing it collapses it into the bell, and later visits keep it there.
 * The settings page's key list links to the same documentation page.
 */
export function useSharedServerNotice(): void {
  const { t, i18n } = useTranslation();
  const [info] = useState(getSharedServerInfo);
  const [startCollapsed] = useState(readCollapsed);
  const linkClass =
    "text-primary underline underline-offset-2 hover:text-primary/80";
  const adviceClass = "flex items-start gap-1.5 font-medium";
  const iconClass = "mt-0.5 h-3.5 w-3.5 shrink-0 text-primary";
  useNotice(
    !info
      ? null
      : {
          key: NOTICE_KEY,
          kind: "card",
          tone: "warning",
          scope: "global",
          title: t("sharedServer.title"),
          body: t("sharedServer.body"),
          render: () => (
            <div className="flex flex-col gap-1 text-xs">
              <p className={adviceClass}>
                <KeyRound aria-hidden="true" className={iconClass} />
                <span>{t("sharedServer.keyAdvice")}</span>
              </p>
              <p className={adviceClass}>
                <HardDrive aria-hidden="true" className={iconClass} />
                <span>{t("sharedServer.saveAdvice")}</span>
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
  // Registered above in an earlier effect, so a returning player gets it
  // straight into the bell.
  useEffect(() => {
    if (info && startCollapsed) dismissNotice(NOTICE_KEY);
  }, [info, startCollapsed]);
  // Watch the store directly: subscribing through React would re-render this
  // producer on every refresh its own rich card triggers.
  useEffect(() => {
    if (!info) return undefined;
    return subscribeNotices(() => {
      const card = getNoticeSnapshot().cards.find(
        (entry) => entry.notice.key === NOTICE_KEY,
      );
      if (card?.collapsed) rememberCollapsed();
    });
  }, [info]);
}
