/**
 * WorldDocumentPanel — renders the current world's WORLD.md (lore field) as
 * Markdown in the right-panel "World" tab. Falls back to description when
 * lore is empty.
 */

import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import type { WorldRecord } from "@/services/api.js";
import { Markdown } from "@/components/ui/markdown.js";
import { text as resolveText } from "@/components/world/editor-helpers.js";

export interface WorldDocumentPanelProps {
  world: WorldRecord | null;
}

export function WorldDocumentPanel({ world }: WorldDocumentPanelProps) {
  const { t } = useTranslation();

  if (!world) {
    return (
      <div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
        {t("session.worldDocumentEmpty", "No world loaded")}
      </div>
    );
  }

  const lore = resolveText(world.lore);
  const description = resolveText(world.description);
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
