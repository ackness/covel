import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  File,
  Film,
  ImageOff,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { text } from "@/components/world/editor-helpers.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { deleteCachedMedia } from "@/lib/media-cache.js";
import { formatSessionDate } from "@/lib/session-display.js";
import { emitToast } from "@/lib/toast-channel.js";
import {
  deleteMediaLibrary,
  listMediaLibrary,
  type MediaLibraryDeleteResult,
  type MediaLibraryItem,
  type MediaLibraryKind,
  type MediaLibraryPage,
  type MediaLibrarySession,
} from "@/services/api/media.js";
import { ApiError } from "@/services/api/request.js";
import { listWorlds } from "@/services/api/worlds.js";
import {
  formatBytes,
  isBatchSelectable,
  itemDeleteConfirmation,
  selectionBytes,
  sessionLabel,
  togglePageSelection,
  toggleSelection,
  unusedDeleteConfirmation,
  withoutIds,
  type MediaSelection,
} from "./media-library-model.js";

/** Items per page; tiles outside the page are not in the document at all. */
const PAGE_SIZE = 48;

/** Sessions named on a tile before the rest collapse into a count. */
const SESSIONS_SHOWN = 3;

const KIND_FILTERS: readonly (MediaLibraryKind | undefined)[] = [
  undefined,
  "image",
  "audio",
  "video",
  "other",
];

type LoadState = "loading" | "ready" | "unavailable" | "error";

function kindLabel(t: TFunction, kind: MediaLibraryKind | undefined): string {
  return t(`mediaLibrary.kind.${kind ?? "all"}`);
}

/**
 * Stored media: what the app keeps for the player's sessions, which sessions
 * use each item, and deletion of what the player chooses. Nothing is deleted
 * without a confirmed action here.
 */
export function MediaLibraryPane() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [kind, setKind] = useState<MediaLibraryKind | undefined>(undefined);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MediaLibraryPage | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [selection, setSelection] = useState<MediaSelection>(new Map());
  const [busy, setBusy] = useState(false);
  const [worldNames, setWorldNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [preview, setPreview] = useState<MediaLibraryItem | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const seq = ++requestSeq.current;
      setState("loading");
      try {
        const next = await listMediaLibrary({
          kind,
          unusedOnly,
          offset,
          limit: PAGE_SIZE,
          refresh,
        });
        if (seq !== requestSeq.current) return;
        // A deletion can empty the last page; step back to one with items.
        if (next.items.length === 0 && next.total > 0 && offset > 0) {
          setOffset(Math.floor((next.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return;
        }
        setPage(next);
        setState("ready");
      } catch (error) {
        if (seq !== requestSeq.current) return;
        setState(
          error instanceof ApiError && error.status === 503
            ? "unavailable"
            : "error",
        );
      }
    },
    [kind, unusedOnly, offset],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    // World names only label the sessions; without them the ID is shown.
    listWorlds()
      .then((worlds) => {
        if (cancelled) return;
        setWorldNames(
          new Map(worlds.map((world) => [world.id, text(world.name, locale)])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const sessions = useMemo(
    () => new Map((page?.sessions ?? []).map((s) => [s.id, s] as const)),
    [page],
  );
  const labelOf = useCallback(
    (session: MediaLibrarySession) =>
      sessionLabel(
        t,
        session,
        session.worldId ? worldNames.get(session.worldId) : undefined,
        locale,
      ),
    [t, worldNames, locale],
  );

  async function afterDelete(result: MediaLibraryDeleteResult) {
    setSelection((current) =>
      withoutIds(current, [
        ...result.deletedIds,
        ...result.skipped.map((entry) => entry.id),
      ]),
    );
    // The play screen keeps its own copy of what it has shown.
    for (const id of result.deletedIds) {
      void deleteCachedMedia(id).catch(() => undefined);
    }
    if (result.deletedIds.length > 0) {
      emitToast(
        "success",
        t("mediaLibrary.deleted", {
          count: result.deletedIds.length,
          size: formatBytes(result.bytesDeleted, locale),
        }),
      );
    }
    if (result.skipped.length > 0) {
      emitToast(
        "info",
        t("mediaLibrary.skipped", { count: result.skipped.length }),
      );
    }
    await load();
  }

  async function runDelete(
    confirmation: Parameters<typeof requestConfirm>[0],
    target: Parameters<typeof deleteMediaLibrary>[0],
  ) {
    if (busy) return;
    if (!(await requestConfirm(confirmation))) return;
    setBusy(true);
    try {
      await afterDelete(await deleteMediaLibrary(target));
    } catch {
      // The request layer has shown the failure; show what is still stored.
      await load(true);
    } finally {
      setBusy(false);
    }
  }

  const deleteSelected = () =>
    runDelete(
      unusedDeleteConfirmation(
        t,
        selection.size,
        selectionBytes(selection),
        locale,
      ),
      { ids: [...selection.keys()] },
    );

  const deleteAllUnused = () =>
    page &&
    runDelete(
      unusedDeleteConfirmation(
        t,
        page.totals.unusedCount,
        page.totals.unusedBytes,
        locale,
      ),
      { unused: true },
    );

  const deleteItem = (item: MediaLibraryItem) =>
    runDelete(
      itemDeleteConfirmation(
        t,
        item,
        item.usedBy.map((id) => {
          const session = sessions.get(id);
          return session ? labelOf(session) : id;
        }),
        locale,
      ),
      item.usage === "unused" ? { ids: [item.id] } : { forceId: item.id },
    );

  if (state === "unavailable") {
    return (
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        {t("mediaLibrary.unavailable")}
      </p>
    );
  }

  const items = page?.items ?? [];
  const selectableOnPage = items.filter(isBatchSelectable);
  const pageFullySelected =
    selectableOnPage.length > 0 &&
    selectableOnPage.every((item) => selection.has(item.id));

  return (
    <div className="space-y-4">
      {page && (
        <div className="space-y-1 text-xs">
          <p className="text-foreground">
            {t("mediaLibrary.summary", {
              count: page.totals.count,
              size: formatBytes(page.totals.bytes, locale),
            })}
          </p>
          <p className="text-muted-foreground">
            {t("mediaLibrary.reclaimable", {
              count: page.totals.unusedCount,
              size: formatBytes(page.totals.unusedBytes, locale),
            })}
          </p>
        </div>
      )}

      {page && !page.scan.complete && (
        <p
          role="status"
          className="border border-border bg-muted px-3 py-2 text-xs leading-relaxed"
        >
          {t("mediaLibrary.scanIncomplete")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("mediaLibrary.kindFilter")}
          className="inline-flex bg-muted p-1"
        >
          {KIND_FILTERS.map((value) => (
            <button
              key={value ?? "all"}
              type="button"
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                setOffset(0);
              }}
              className={
                "px-3 py-1 text-xs font-medium transition-colors " +
                (kind === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {kindLabel(t, value)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={unusedOnly}
            onChange={(event) => {
              setUnusedOnly(event.target.checked);
              setOffset(0);
            }}
          />
          {t("mediaLibrary.unusedOnly")}
        </label>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={state === "loading" || busy}
          onClick={() => void load(true)}
        >
          {state === "loading" ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 size-3" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selectableOnPage.length === 0}
          onClick={() =>
            setSelection((current) => togglePageSelection(current, items))
          }
        >
          {pageFullySelected
            ? t("mediaLibrary.clearPage")
            : t("mediaLibrary.selectPage")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy || selection.size === 0}
          onClick={() => void deleteSelected()}
        >
          <Trash2 className="mr-1 size-3" />
          {t("mediaLibrary.deleteSelected", {
            count: selection.size,
            size: formatBytes(selectionBytes(selection), locale),
          })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy || !page || page.totals.unusedCount === 0}
          onClick={() => void deleteAllUnused()}
        >
          <Trash2 className="mr-1 size-3" />
          {t("mediaLibrary.deleteAllUnused")}
        </Button>
      </div>

      {state === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {t("mediaLibrary.loadFailed")}
        </p>
      )}

      {page && items.length === 0 && state === "ready" && (
        <p className="text-xs text-muted-foreground">
          {t("mediaLibrary.empty")}
        </p>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <MediaTile
            key={item.id}
            item={item}
            selected={selection.has(item.id)}
            busy={busy}
            sessions={sessions}
            labelOf={labelOf}
            onToggle={() =>
              setSelection((current) => toggleSelection(current, item))
            }
            onDelete={() => void deleteItem(item)}
            onPreview={() => setPreview(item)}
          />
        ))}
      </ul>

      {page && page.total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t("mediaLibrary.pageRange", {
              from: page.offset + 1,
              to: page.offset + items.length,
              total: page.total,
            })}
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || state === "loading"}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t("mediaLibrary.previousPage")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + PAGE_SIZE >= page.total || state === "loading"}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {t("mediaLibrary.nextPage")}
            </Button>
          </span>
        </div>
      )}

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate text-sm">
              {preview ? itemName(t, preview) : ""}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("mediaLibrary.previewDescription")}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <img
              src={preview.url}
              alt={itemName(t, preview)}
              className="mx-auto block max-h-[75vh] max-w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function itemName(t: TFunction, item: MediaLibraryItem): string {
  return item.name ?? t(`mediaLibrary.kind.${item.kind}`);
}

interface MediaTileProps {
  readonly item: MediaLibraryItem;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly sessions: ReadonlyMap<string, MediaLibrarySession>;
  readonly labelOf: (session: MediaLibrarySession) => string;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
  readonly onPreview: () => void;
}

function MediaTile({
  item,
  selected,
  busy,
  sessions,
  labelOf,
  onToggle,
  onDelete,
  onPreview,
}: MediaTileProps) {
  const { t, i18n } = useTranslation();
  const name = itemName(t, item);
  return (
    <li
      className={
        "flex min-w-0 flex-col overflow-hidden rounded-(--radius-card) border bg-card " +
        (selected ? "border-primary" : "border-border")
      }
    >
      <div className="relative aspect-square bg-muted">
        <MediaTilePreview item={item} name={name} onPreview={onPreview} />
        {isBatchSelectable(item) && (
          <input
            type="checkbox"
            aria-label={t("mediaLibrary.selectItem", { name })}
            checked={selected}
            disabled={busy}
            onChange={onToggle}
            className="absolute left-2 top-2 size-4"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground" title={name}>
              {name}
            </p>
            <p className="text-muted-foreground">
              {formatBytes(item.size, i18n.language)} ·{" "}
              {formatSessionDate(item.createdAt, i18n.language)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="size-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
            aria-label={t("mediaLibrary.deleteItem", { name })}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        <MediaTileUsage item={item} sessions={sessions} labelOf={labelOf} />
      </div>
    </li>
  );
}

function MediaTileUsage({
  item,
  sessions,
  labelOf,
}: Pick<MediaTileProps, "item" | "sessions" | "labelOf">) {
  const { t } = useTranslation();
  if (item.usage === "unused") {
    return (
      <Badge variant="outline" className="self-start font-normal">
        {t("mediaLibrary.usageUnused")}
      </Badge>
    );
  }
  if (item.usage !== "used") {
    return (
      <p className="text-muted-foreground">
        {t(
          item.usage === "held"
            ? "mediaLibrary.usageHeld"
            : "mediaLibrary.usageUnknown",
        )}
      </p>
    );
  }
  const shown = item.usedBy.slice(0, SESSIONS_SHOWN);
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{t("mediaLibrary.usedBy")}</p>
      <ul className="space-y-0.5">
        {shown.map((id) => {
          const session = sessions.get(id);
          return (
            <li key={id} className="truncate">
              <a
                href={`/session?sid=${encodeURIComponent(id)}`}
                className="text-foreground underline-offset-2 hover:underline"
              >
                {session ? labelOf(session) : id}
              </a>
            </li>
          );
        })}
      </ul>
      {item.usedBy.length > shown.length && (
        <p className="text-muted-foreground">
          {t("mediaLibrary.moreSessions", {
            count: item.usedBy.length - shown.length,
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The server offers no smaller rendition, so a picture is the original,
 * requested only when its tile nears the viewport. Audio and video fetch
 * nothing until the player starts them.
 */
function MediaTilePreview({
  item,
  name,
  onPreview,
}: {
  readonly item: MediaLibraryItem;
  readonly name: string;
  readonly onPreview: () => void;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);

  if (item.kind === "image" && !broken) {
    return (
      <button
        type="button"
        className="block size-full"
        aria-label={t("mediaLibrary.enlarge", { name })}
        onClick={onPreview}
      >
        <img
          src={item.url}
          alt={name}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      </button>
    );
  }
  if (item.kind === "audio") {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-3 p-2">
        <Music aria-hidden className="size-8 text-muted-foreground" />
        <audio
          src={item.url}
          controls
          preload="none"
          aria-label={name}
          className="w-full"
        />
      </div>
    );
  }
  if (item.kind === "video") {
    return playing ? (
      <video
        src={item.url}
        controls
        autoPlay
        aria-label={name}
        className="size-full object-contain"
      />
    ) : (
      <button
        type="button"
        className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
        onClick={() => setPlaying(true)}
      >
        <Film aria-hidden className="size-8" />
        <span className="text-xs">{t("mediaLibrary.playVideo")}</span>
      </button>
    );
  }
  const Icon = item.kind === "image" ? ImageOff : File;
  return (
    <div
      role="img"
      aria-label={
        item.kind === "image" ? t("media.unavailable") : item.mime || name
      }
      className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground"
    >
      <Icon aria-hidden className="size-8" />
      <span className="max-w-full truncate px-2 text-[10px]">
        {item.kind === "image" ? t("media.unavailable") : item.mime}
      </span>
    </div>
  );
}
