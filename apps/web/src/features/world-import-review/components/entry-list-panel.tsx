import { useTranslation } from "react-i18next";
import { CheckCircle2, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { countByType, filterEntriesByType } from "../draft-actions.js";
import type {
  EntryType,
  WorldImportDraft,
  WorldImportDraftEntry,
} from "../types.js";
import { ENTRY_TYPES } from "../types.js";
import { ProvenanceBadge } from "./provenance-badge.js";

/**
 * Left pane of the review page: category filter and the entry list. The
 * list keeps import order; provenance badges carry the at-a-glance signal.
 */

function CategoryChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-(--radius-control) border transition-colors",
        active
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted/40",
      )}
    >
      <span>{label}</span>
      <span className="text-[10px] font-semibold tabular-nums opacity-75">
        {count}
      </span>
    </button>
  );
}

function EntryListItem({
  entry,
  selected,
  onSelect,
  typeLabel,
}: {
  entry: WorldImportDraftEntry;
  selected: boolean;
  onSelect: () => void;
  typeLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full text-left border px-3 py-2.5 rounded-(--radius-control) transition-colors",
        selected
          ? "border-primary/60 bg-muted/60"
          : "border-border/70 hover:bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">{entry.name}</span>
        <ProvenanceBadge status={entry.provenanceStatus} className="shrink-0" />
      </div>
      {entry.aliases.length > 0 && (
        <div className="mt-0.5 text-xs text-muted-foreground truncate">
          {entry.aliases.join(" · ")}
        </div>
      )}
      <div className="mt-1.5 flex items-center flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="border border-border/70 px-1.5 py-px rounded-(--radius-control)">
          {typeLabel}
        </span>
        {entry.userEdited && (
          <span className="inline-flex items-center gap-1 text-primary">
            <PencilLine className="h-3 w-3" aria-hidden />
            {t("worldImport.detail.userEdited")}
          </span>
        )}
        {entry.provenanceStatus === "ai-inferred" && entry.aiAccepted && (
          <span className="inline-flex items-center gap-1 text-primary">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            {t("worldImport.ai.accepted")}
          </span>
        )}
        {entry.provenanceStatus === "conflict" && entry.conflictResolved && (
          <span className="inline-flex items-center gap-1 text-primary">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            {t("worldImport.conflict.resolved")}
          </span>
        )}
      </div>
    </button>
  );
}

export interface EntryListPanelProps {
  draft: WorldImportDraft;
  activeType: EntryType | null;
  onTypeChange: (type: EntryType | null) => void;
  selectedEntryId: string | null;
  onSelectEntry: (entryId: string) => void;
}

export function EntryListPanel({
  draft,
  activeType,
  onTypeChange,
  selectedEntryId,
  onSelectEntry,
}: EntryListPanelProps) {
  const { t } = useTranslation();
  const typeCounts = countByType(draft);
  const visibleEntries = filterEntriesByType(draft, activeType);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        <CategoryChip
          label={t("worldImport.filter.all")}
          count={draft.entries.length}
          active={activeType === null}
          onClick={() => onTypeChange(null)}
        />
        {ENTRY_TYPES.map((type) => (
          <CategoryChip
            key={type}
            label={t(`worldImport.category.${type}`)}
            count={typeCounts[type]}
            active={activeType === type}
            onClick={() => onTypeChange(type)}
          />
        ))}
      </div>

      {visibleEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border/70 rounded-(--radius-control) px-3 py-6 text-center">
          {t("worldImport.list.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleEntries.map((entry) => (
            <EntryListItem
              key={entry.id}
              entry={entry}
              selected={entry.id === selectedEntryId}
              onSelect={() => onSelectEntry(entry.id)}
              typeLabel={t(`worldImport.category.${entry.type}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
