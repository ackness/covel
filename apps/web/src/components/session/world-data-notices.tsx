import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { WorldDataImportNotice } from "@covel/shared";
import { useNotice } from "@/lib/notice-center.js";

/** Categories that have a card of their own; the rest share one. */
const CATEGORY_TITLES = {
  "receiver-ambiguous": "session.worldDataNotices.titles.ambiguous",
  "receiver-excluded": "session.worldDataNotices.titles.excluded",
  "receiver-missing": "session.worldDataNotices.titles.missing",
} as const;

/** The card of a notice goes by its code; unknown codes are import failures. */
function categoryOf(notice: WorldDataImportNotice): string {
  return notice.code && notice.code in CATEGORY_TITLES
    ? notice.code
    : "import-failed";
}

/** One plain line for a notice, in the interface language. */
function noticeLine(t: TFunction, notice: WorldDataImportNotice): string {
  const omission = (message: string) =>
    notice.publicLabel
      ? t("session.worldDataNotices.labeled", {
          source: notice.publicLabel,
          message,
        })
      : message;
  switch (notice.code) {
    case "receiver-ambiguous":
      return omission(t("session.worldDataNotices.receiverAmbiguous"));
    case "receiver-excluded":
      return omission(t("session.worldDataNotices.receiverExcluded"));
    case "receiver-missing":
      return omission(t("session.worldDataNotices.receiverMissing"));
    default:
      return notice.sourceId
        ? t("session.worldDataNotices.sourceNotImported", {
            source: notice.sourceId,
          })
        : t("session.worldDataNotices.notImported");
  }
}

/**
 * Cards for the world data this game is without, one per kind of problem.
 * What a plugin still waiting for approval would receive is part of the
 * approval card, and world-state problems are part of the world-state card.
 * The data arrives when the plugin is turned on.
 */
export function WorldDataNoticeCards({
  notices,
  sessionId,
}: {
  readonly notices: readonly WorldDataImportNotice[];
  readonly sessionId: string;
}): null {
  const { t } = useTranslation();
  const groups = new Map<string, WorldDataImportNotice[]>();
  for (const notice of notices) {
    if (
      notice.code === "receiver-approval-required" ||
      notice.code === "dimension-provider-missing"
    )
      continue;
    const category = categoryOf(notice);
    groups.set(category, [...(groups.get(category) ?? []), notice]);
  }
  const card = (category: string) => {
    const group = groups.get(category);
    if (!group) return null;
    const titleKey =
      CATEGORY_TITLES[category as keyof typeof CATEGORY_TITLES] ??
      "session.worldDataNotices.titles.importFailed";
    const raw = group
      .filter((notice) => categoryOf(notice) === "import-failed")
      .map((notice) => notice.message)
      .join("\n");
    return {
      key: `world-data:${category}`,
      kind: "card" as const,
      tone: "warning" as const,
      scope: sessionId,
      title: t(titleKey),
      body: group.map((notice) => noticeLine(t, notice)).join("\n"),
      ...(raw ? { detail: raw } : {}),
    };
  };
  // A fixed set of hooks: one per category, `null` when it has no notices.
  useNotice(card("receiver-ambiguous"));
  useNotice(card("receiver-excluded"));
  useNotice(card("receiver-missing"));
  useNotice(card("import-failed"));
  return null;
}

/**
 * Known omission reasons use the interface language. Generic import failures
 * retain the host's fixed safe message under "Details".
 */
export function WorldDataNoticeText({
  notice,
}: {
  readonly notice: Pick<
    WorldDataImportNotice,
    "code" | "sourceId" | "publicLabel" | "message"
  >;
}) {
  const { t } = useTranslation();
  const source = notice.sourceId ?? "";
  const omission = (message: string) =>
    notice.publicLabel
      ? t("session.worldDataNotices.labeled", {
          source: notice.publicLabel,
          message,
        })
      : message;
  switch (notice.code) {
    case "dimension-provider-missing":
      return <>{t("session.worldDataNotices.dimensionsMissing")}</>;
    case "receiver-ambiguous":
      return <>{omission(t("session.worldDataNotices.receiverAmbiguous"))}</>;
    case "receiver-excluded":
      return <>{omission(t("session.worldDataNotices.receiverExcluded"))}</>;
    case "receiver-approval-required":
      return (
        <>{omission(t("session.worldDataNotices.receiverApprovalRequired"))}</>
      );
    case "receiver-missing":
      return <>{omission(t("session.worldDataNotices.receiverMissing"))}</>;
    default:
      return (
        <details className="inline">
          <summary className="cursor-pointer">
            {source
              ? t("session.worldDataNotices.sourceNotImported", { source })
              : t("session.worldDataNotices.notImported")}
          </summary>
          <span className="text-muted-foreground">{notice.message}</span>
        </details>
      );
  }
}
