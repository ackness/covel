import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { countByProvenance, findEntry } from "../draft-actions.js";
import { downloadWorldImportDraft } from "../draft-service.js";
import { WorldImportDraftStore } from "../draft-store.js";
import { useDraftReview } from "../use-draft-review.js";
import type { EntryType } from "../types.js";
import { EntryDetailPanel } from "./entry-detail-panel.js";
import { EntryListPanel } from "./entry-list-panel.js";
import { ProvenanceBadge } from "./provenance-badge.js";

/**
 * World Import Review page — route /world-import-review.
 *
 * The owner-facing gate between AI extraction (Dev B) and the approved
 * WorldImportDraft: inspect what was extracted, see what is source-backed
 * vs AI-inferred vs conflicting, edit, decide, save, export.
 */

function StatChip({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: "destructive";
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={
          emphasis === "destructive"
            ? "text-lg font-semibold text-destructive tabular-nums"
            : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function ReviewPage({ store }: { store?: WorldImportDraftStore }) {
  const { t } = useTranslation();
  const review = useDraftReview(store);
  const [activeType, setActiveType] = useState<EntryType | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const draft = review.draft;
  const counts = draft ? countByProvenance(draft) : null;
  const selectedEntry = draft ? findEntry(draft, selectedEntryId) : null;

  const handleReset = async () => {
    const approved = await requestConfirm({
      title: t("worldImport.reset.confirmTitle"),
      message: t("worldImport.reset.confirmMessage"),
      confirmLabel: t("worldImport.reset.action"),
      cancelLabel: t("common.cancel"),
    });
    if (!approved) return;
    setSelectedEntryId(null);
    await review.resetToFixture();
  };

  if (review.loadState.status === "loading") {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground animate-pulse">
          {t("worldImport.status.loading")}
        </p>
      </div>
    );
  }

  if (review.loadState.status === "error" || !draft || !counts) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive">
          {review.loadState.status === "error"
            ? review.loadState.message
            : t("worldImport.status.error")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void review.reload()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("worldImport.status.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto overscroll-contain">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-5 md:py-8">
        <header className="mb-6">
          <p className="ui-eyebrow text-muted-foreground mb-2">
            {t("worldImport.eyebrow")}
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display font-bold tracking-tight text-2xl md:text-3xl leading-tight">
                {draft.title}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground font-mono">
                {draft.id} ·{" "}
                {t("worldImport.metaVersion", { version: draft.version })}
              </p>
            </div>
            <div className="flex items-center flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!review.dirty || review.saving}
                onClick={() => void review.save()}
              >
                <Save className="h-3.5 w-3.5" />
                {t("worldImport.action.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadWorldImportDraft(draft)}
              >
                <Download className="h-3.5 w-3.5" />
                {t("worldImport.action.export")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={review.resetting}
                onClick={() => void handleReset()}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("worldImport.reset.action")}
              </Button>
            </div>
          </div>

          <p className="mt-3 max-w-3xl text-sm text-muted-foreground leading-relaxed">
            {draft.summary}
          </p>

          <div className="mt-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
            {draft.sources.map((source) => (
              <span
                key={source.id}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground border border-border/70 rounded-(--radius-control) px-2 py-0.5"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-(--accent-primary)"
                  aria-hidden
                />
                {source.title}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              {review.savedAt
                ? t("worldImport.savedAt", {
                    time: new Date(review.savedAt).toLocaleString(),
                  })
                : t("worldImport.notSavedYet")}
            </span>
            {review.dirty && (
              <span className="text-xs font-medium text-primary">
                {t("worldImport.unsaved")}
              </span>
            )}
          </div>
        </header>

        <section className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border/70 py-3 mb-6">
          <StatChip label={t("worldImport.stats.total")} value={counts.total} />
          <StatChip
            label={t("worldImport.stats.sourceBacked")}
            value={counts.sourceBacked}
          />
          <StatChip
            label={t("worldImport.stats.aiInferred")}
            value={counts.aiInferred}
          />
          <StatChip
            label={t("worldImport.stats.conflict")}
            value={counts.conflict}
            emphasis={
              counts.unresolvedConflicts > 0 ? "destructive" : undefined
            }
          />
          {counts.unresolvedConflicts > 0 && (
            <ProvenanceBadge status="conflict" />
          )}
          {counts.unresolvedConflicts > 0 && (
            <span className="text-xs text-destructive">
              {t("worldImport.export.conflictWarning", {
                count: counts.unresolvedConflicts,
              })}
            </span>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 lg:sticky lg:top-4">
            <EntryListPanel
              draft={draft}
              activeType={activeType}
              onTypeChange={setActiveType}
              selectedEntryId={selectedEntryId}
              onSelectEntry={setSelectedEntryId}
            />
          </div>
          <div className="lg:col-span-7">
            <EntryDetailPanel
              draft={draft}
              entry={selectedEntry}
              onEdit={review.editEntry}
              onAcceptAi={review.acceptAi}
              onRemoveEntry={(entryId) => {
                review.removeEntry(entryId);
                if (entryId === selectedEntryId) setSelectedEntryId(null);
              }}
              onResolveConflict={review.resolveConflict}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
