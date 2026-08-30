import { useTranslation } from "react-i18next";
import { CheckCircle2, MousePointerClick, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { inputCls, textareaCls } from "@/components/world/editor-helpers.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { cn } from "@/lib/utils.js";
import { resolveSourceTitle, type EntryEditPatch } from "../draft-actions.js";
import type { WorldImportDraft, WorldImportDraftEntry } from "../types.js";
import { ProvenanceBadge } from "./provenance-badge.js";

/**
 * Right pane of the review page: the owner-facing editor for one entry.
 * Every content edit funnels through onEdit, which stamps userEdited.
 */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="ui-eyebrow block mb-1.5 text-muted-foreground">
      {children}
    </label>
  );
}

function AliasEditor({
  entry,
  onEdit,
}: {
  entry: WorldImportDraftEntry;
  onEdit: (entryId: string, patch: EntryEditPatch) => void;
}) {
  const { t } = useTranslation();
  const setAliases = (aliases: string[]) => onEdit(entry.id, { aliases });
  return (
    <div>
      <FieldLabel>{t("worldImport.detail.aliases")}</FieldLabel>
      <div className="flex flex-col gap-1.5">
        {entry.aliases.map((alias, index) => (
          <div key={`${index}-${alias}`} className="flex items-center gap-1.5">
            <input
              className={inputCls}
              value={alias}
              aria-label={t("worldImport.detail.aliasItem", {
                index: index + 1,
              })}
              onChange={(event) =>
                setAliases(
                  entry.aliases.map((a, i) =>
                    i === index ? event.target.value : a,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("worldImport.detail.removeAlias", {
                index: index + 1,
              })}
              onClick={() =>
                setAliases(entry.aliases.filter((_, i) => i !== index))
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setAliases([...entry.aliases, ""])}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("worldImport.detail.addAlias")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceRefsSection({
  draft,
  entry,
}: {
  draft: WorldImportDraft;
  entry: WorldImportDraftEntry;
}) {
  const { t } = useTranslation();
  if (entry.sourceRefs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground border border-dashed border-border/70 rounded-(--radius-control) px-3 py-2.5">
        {t("worldImport.detail.noSourceRefs")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {entry.sourceRefs.map((ref, index) => (
        <div
          key={`${ref.sourceId}-${index}`}
          className="border border-border/70 rounded-(--radius-control) px-3 py-2.5"
        >
          <div className="text-xs font-medium">
            {resolveSourceTitle(draft, ref.sourceId)}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground font-mono">
            {ref.locator}
          </div>
          {ref.quote && (
            <blockquote className="mt-1.5 border-l-2 border-border pl-2.5 text-xs text-muted-foreground italic">
              {ref.quote}
            </blockquote>
          )}
        </div>
      ))}
    </div>
  );
}

function ConflictSection({
  entry,
  onEdit,
  onResolveConflict,
}: {
  entry: WorldImportDraftEntry;
  onEdit: (entryId: string, patch: EntryEditPatch) => void;
  onResolveConflict: (entryId: string, resolved: boolean) => void;
}) {
  const { t } = useTranslation();
  if (entry.provenanceStatus !== "conflict") return null;
  return (
    <section className="border border-destructive/40 bg-destructive/5 rounded-(--radius-control) p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="ui-eyebrow text-destructive">
          {t("worldImport.conflict.title")}
        </h3>
        {entry.conflictResolved && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t("worldImport.conflict.resolved")}
          </span>
        )}
      </div>
      <FieldLabel>{t("worldImport.conflict.notes")}</FieldLabel>
      <textarea
        className={cn(textareaCls, "min-h-16")}
        value={entry.conflictNotes ?? ""}
        aria-label={t("worldImport.conflict.notes")}
        onChange={(event) =>
          onEdit(entry.id, { conflictNotes: event.target.value })
        }
      />
      <div className="mt-2">
        <Button
          type="button"
          variant={entry.conflictResolved ? "secondary" : "outline"}
          size="sm"
          onClick={() => onResolveConflict(entry.id, !entry.conflictResolved)}
        >
          {entry.conflictResolved
            ? t("worldImport.conflict.unmark")
            : t("worldImport.conflict.markResolved")}
        </Button>
      </div>
    </section>
  );
}

function AiInferenceSection({
  entry,
  onAcceptAi,
  onRemoveEntry,
}: {
  entry: WorldImportDraftEntry;
  onAcceptAi: (entryId: string) => void;
  onRemoveEntry: (entryId: string) => void;
}) {
  const { t } = useTranslation();
  if (entry.provenanceStatus !== "ai-inferred") return null;
  const handleDelete = async () => {
    const approved = await requestConfirm({
      title: t("worldImport.ai.deleteConfirmTitle"),
      message: t("worldImport.ai.deleteConfirmMessage", { name: entry.name }),
      confirmLabel: t("worldImport.ai.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (approved) onRemoveEntry(entry.id);
  };
  return (
    <section className="border border-border/70 rounded-(--radius-control) p-3">
      <h3 className="ui-eyebrow mb-2 text-muted-foreground">
        {t("worldImport.ai.title")}
      </h3>
      <div className="flex items-center flex-wrap gap-2">
        {entry.aiAccepted ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {t("worldImport.ai.accepted")}
          </span>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onAcceptAi(entry.id)}
          >
            <MousePointerClick className="h-3.5 w-3.5" />
            {t("worldImport.ai.accept")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => void handleDelete()}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("worldImport.ai.delete")}
        </Button>
      </div>
    </section>
  );
}

export interface EntryDetailPanelProps {
  draft: WorldImportDraft;
  entry: WorldImportDraftEntry | null;
  onEdit: (entryId: string, patch: EntryEditPatch) => void;
  onAcceptAi: (entryId: string) => void;
  onRemoveEntry: (entryId: string) => void;
  onResolveConflict: (entryId: string, resolved: boolean) => void;
}

export function EntryDetailPanel({
  draft,
  entry,
  onEdit,
  onAcceptAi,
  onRemoveEntry,
  onResolveConflict,
}: EntryDetailPanelProps) {
  const { t } = useTranslation();
  if (!entry) {
    return (
      <div className="h-full min-h-40 flex flex-col items-center justify-center gap-2 border border-dashed border-border/70 rounded-(--radius-control) text-center px-6 py-10">
        <p className="text-sm text-muted-foreground">
          {t("worldImport.detail.noSelection")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-snug wrap-break-word">
            {entry.name}
          </h2>
          <p className="ui-eyebrow mt-1 text-muted-foreground">
            {t(`worldImport.category.${entry.type}`)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ProvenanceBadge status={entry.provenanceStatus} />
          {entry.userEdited && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary border border-primary/40 rounded-(--radius-control) px-1.5 py-0.5">
              {t("worldImport.detail.userEdited")}
            </span>
          )}
        </div>
      </header>

      <AiInferenceSection
        entry={entry}
        onAcceptAi={onAcceptAi}
        onRemoveEntry={onRemoveEntry}
      />
      <ConflictSection
        entry={entry}
        onEdit={onEdit}
        onResolveConflict={onResolveConflict}
      />

      <div>
        <FieldLabel>{t("worldImport.detail.name")}</FieldLabel>
        <input
          className={inputCls}
          value={entry.name}
          aria-label={t("worldImport.detail.name")}
          onChange={(event) => onEdit(entry.id, { name: event.target.value })}
        />
      </div>

      <AliasEditor entry={entry} onEdit={onEdit} />

      <div>
        <FieldLabel>{t("worldImport.detail.content")}</FieldLabel>
        <textarea
          className={cn(textareaCls, "min-h-36")}
          value={entry.content}
          aria-label={t("worldImport.detail.content")}
          onChange={(event) =>
            onEdit(entry.id, { content: event.target.value })
          }
        />
      </div>

      <div>
        <FieldLabel>{t("worldImport.detail.sourceRefs")}</FieldLabel>
        <SourceRefsSection draft={draft} entry={entry} />
      </div>
    </div>
  );
}
