/**
 * WorldDocumentPanel — renders the current world's WORLD.md (lore field) as
 * Markdown in the right-panel "World" tab, without its narrator-only blocks.
 * Falls back to description when nothing of the lore is left.
 */

import { localizedWorldText, playerVisibleLore } from "@covel/shared";
import { useTranslation } from "react-i18next";
import type { WorldSummary } from "@/services/api.js";
import { useWorldRecord } from "@/services/world-records.js";
import { Markdown } from "@/components/ui/markdown.js";
import { text as resolveText } from "@/components/world/editor-helpers.js";

export interface WorldDocumentPanelProps {
  /** The summary paints the description until the full record's lore arrives. */
  world: WorldSummary | null;
  /** The session's content language; the world's own language without one. */
  locale?: string;
}

export function WorldDocumentPanel({ world, locale }: WorldDocumentPanelProps) {
  const { t } = useTranslation();
  const record = useWorldRecord(world?.id);

  if (!world) {
    return (
      <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
        {t("session.worldDocumentEmpty", "No world loaded")}
      </div>
    );
  }

  // The edition the session plays in, not always the world's own language.
  const shown = localizedWorldText(
    {
      description: resolveText(world.description),
      lore: resolveText(record.world?.lore),
      locale: world.locale,
      // The lore translations are in the full record's metadata only.
      metadata: record.world?.metadata ?? world.metadata,
    },
    locale,
  );
  const lore = playerVisibleLore(shown.lore ?? "").trim();
  const description = shown.description ?? "";
  const body = lore || description;

  if (!body) {
    return (
      <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
        {t("session.worldDocumentEmpty", "No world document")}
      </div>
    );
  }

  return (
    <article className="prose prose-sm dark:prose-invert max-w-none text-[12px] leading-relaxed">
      <Markdown>{body}</Markdown>
    </article>
  );
}
