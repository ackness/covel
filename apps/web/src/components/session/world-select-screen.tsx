import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Languages } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { SettingsDialog } from "@/settings/SettingsDialog.js";
import { WorldDetailView } from "@/components/world/world-detail-view.js";
import { isWorldDeletable } from "@/components/world/world-deletion.js";
import { WorldEditor } from "@/components/world/world-editor.js";
import { AiWorldGenerator } from "@/components/world/ai-world-generator.js";
import { WorldListView } from "@/components/world/world-list-view.js";
import * as api from "@/services/api.js";
import type { WorldRecord, PackageSummary } from "@/services/api.js";
import { text } from "@/components/world/editor-helpers.js";
import { formatSlotLabel, type ResolvedSlot } from "@/hooks/use-slot-config.js";
import {
  isWorldLocaleMismatch,
  prioritizeWorldsByLocale,
  worldLanguageName,
} from "@/lib/world-locale.js";
import i18n from "@/i18n";
import { DEFAULT_FALLBACK_LOCALE } from "@covel/shared";

type ViewMode = "list" | "detail" | "edit";

interface WorldSelectScreenProps {
  worlds: WorldRecord[];
  packages: PackageSummary[];
  resolvedSlots: ResolvedSlot[];
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  settingsInitialKey?: string;
  onSelectWorld: (worldId: string) => void;
  onWorldUpdated?: (world: WorldRecord) => void;
  onWorldCreated?: (world: WorldRecord) => void;
  onWorldDeleted?: (worldId: string) => void;
}

export function worldStorageLabel(world: WorldRecord): string {
  const metadata = world.metadata;
  const storage = metadata?.storage as
    | {
        scope?: string;
        backend?: string;
      }
    | undefined;
  if (storage?.scope === "browser" && storage.backend === "indexeddb") {
    return i18n.t("session.storage.browserIndexedDb", "Browser IndexedDB");
  }
  if (storage?.scope === "server" && storage.backend === "file") {
    return i18n.t("session.storage.serverFile", "Server file");
  }
  if (storage?.scope === "server" && storage.backend) {
    return i18n.t("session.storage.serverBackend", {
      backend: storage.backend,
      defaultValue: "Server {{backend}}",
    });
  }
  if (metadata?.source === "file")
    return i18n.t("session.storage.builtIn", "Built-in");
  if (metadata?.source === "browser-indexeddb")
    return i18n.t("session.storage.browserIndexedDb", "Browser IndexedDB");
  if (metadata?.source === "server-store")
    return i18n.t("session.storage.serverStore", "Server store");
  return i18n.t("session.storage.server", "Server");
}

export function WorldSelectScreen({
  worlds,
  packages,
  resolvedSlots,
  settingsOpen,
  onSettingsOpenChange,
  settingsInitialKey,
  onSelectWorld,
  onWorldUpdated,
  onWorldCreated,
  onWorldDeleted,
}: WorldSelectScreenProps) {
  const { t, i18n: translation } = useTranslation();
  const primarySlotLabel = formatSlotLabel(resolvedSlots[0]);
  const enabledPluginCount = packages.filter((p) => p.enabled).length;
  const prioritizedWorlds = useMemo(
    () =>
      prioritizeWorldsByLocale(
        worlds,
        translation.resolvedLanguage ?? translation.language,
      ),
    [worlds, translation.language, translation.resolvedLanguage],
  );

  const [mode, setMode] = useState<ViewMode>("list");
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [enteringWorldId, setEnteringWorldId] = useState<string | null>(null);
  const [pendingWorldId, setPendingWorldId] = useState<string | null>(null);
  const [deletingWorldId, setDeletingWorldId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Entering a world used to defer the actual navigation to
  // `requestAnimationFrame`, so the busy state could paint one frame first.
  // Browsers pause rAF while a page is hidden, so a click on a backgrounded
  // or throttled tab set the busy flag and then never navigated: the card
  // spun forever, every other card went `pointer-events-none`, and there was
  // no error and no way back short of a reload. Selecting a world is two
  // dispatches — nothing worth deferring behind a frame that may never come.
  const activeLocale =
    translation.resolvedLanguage ?? translation.language ?? undefined;

  function enterWorld(worldId: string) {
    if (enteringWorldId) return;
    setPendingWorldId(null);
    setEnteringWorldId(worldId);
    onSelectWorld(worldId);
  }

  function handleEnterWorld(worldId: string) {
    if (enteringWorldId) return;
    const world = worlds.find((item) => item.id === worldId);
    if (world && isWorldLocaleMismatch(world.locale, activeLocale)) {
      setPendingWorldId(worldId);
      return;
    }
    enterWorld(worldId);
  }

  // A successful selection unmounts this screen, so the flag disappears with
  // it. Still being mounted means the navigation did not take — release the
  // lock instead of stranding the player on a dead grid.
  useEffect(() => {
    if (!enteringWorldId) return;
    const timer = setTimeout(() => setEnteringWorldId(null), 1500);
    return () => clearTimeout(timer);
  }, [enteringWorldId]);

  const selectedWorld = selectedWorldId
    ? (worlds.find((w) => w.id === selectedWorldId) ?? null)
    : null;

  function handleViewDetails(e: React.MouseEvent, worldId: string) {
    e.stopPropagation();
    setSelectedWorldId(worldId);
    setMode("detail");
  }

  function handleBack() {
    setMode("list");
    setSelectedWorldId(null);
  }

  function handleEditFromDetail() {
    setMode("edit");
  }

  function handleSave(updated: WorldRecord) {
    onWorldUpdated?.(updated);
    setMode("detail");
  }

  function handleDeleteClick(e: React.MouseEvent, worldId: string) {
    e.stopPropagation();
    setDeletingWorldId(worldId);
    setDeleteConfirmOpen(true);
  }

  function handleDeleteFromDetail(worldId: string) {
    setDeletingWorldId(worldId);
    setDeleteConfirmOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!deletingWorldId || deleting) return;
    setDeleting(true);
    try {
      await api.deleteWorld(deletingWorldId);
      onWorldDeleted?.(deletingWorldId);
      handleBack();
    } catch {
      // toast already shown by api request handler
    } finally {
      setDeleting(false);
      setDeletingWorldId(null);
      setDeleteConfirmOpen(false);
    }
  }

  const deletingWorld = deletingWorldId
    ? worlds.find((world) => world.id === deletingWorldId)
    : null;
  const pendingWorld = pendingWorldId
    ? worlds.find((world) => world.id === pendingWorldId)
    : null;

  function localeName(locale: string | undefined): string {
    return worldLanguageName(locale, activeLocale) ?? locale ?? "";
  }

  const localeMismatchDialog = (
    <Dialog
      open={pendingWorld !== null}
      onOpenChange={(open) => {
        if (!open) setPendingWorldId(null);
      }}
    >
      <DialogContent
        className="max-w-[calc(100vw-2rem)] gap-5 p-5 sm:max-w-lg sm:p-6"
        showCloseButton={false}
      >
        <div className="flex items-start gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-(--radius-control) border border-primary/25 bg-primary/10 text-primary">
            <Languages className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-left">
            <p className="ui-eyebrow text-[10px] text-primary">
              {t("world.localeMismatchEyebrow", "Language notice")}
            </p>
            <DialogTitle className="text-xl leading-tight">
              {pendingWorld
                ? t("world.localeMismatchTitle", {
                    language: localeName(pendingWorld.locale),
                    defaultValue: "Continue with a {{language}} world?",
                  })
                : null}
            </DialogTitle>
            <DialogDescription className="max-w-md leading-relaxed">
              {pendingWorld
                ? t("world.localeMismatchDesc", {
                    name: text(pendingWorld.name, activeLocale),
                    worldLanguage: localeName(pendingWorld.locale),
                    interfaceLanguage: localeName(activeLocale),
                    defaultValue:
                      '"{{name}}" is written in {{worldLanguage}}, while Covel is currently displayed in {{interfaceLanguage}}.',
                  })
                : null}
            </DialogDescription>
          </div>
        </div>

        {pendingWorld && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-(--radius-card) border border-(--rule-color) bg-muted/30 px-4 py-3">
            <div className="min-w-0">
              <p className="ui-meta text-[9px] text-muted-foreground">
                {t("world.localeMismatchInterface", "Interface")}
              </p>
              <p className="mt-1 truncate text-sm font-medium">
                {localeName(activeLocale)}
              </p>
            </div>
            <ArrowRight className="size-4 text-muted-foreground/60" />
            <div className="min-w-0 text-right">
              <p className="ui-meta text-[9px] text-muted-foreground">
                {t("world.localeMismatchWorld", "World content")}
              </p>
              <p className="mt-1 truncate text-sm font-medium text-primary">
                {localeName(pendingWorld.locale)}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 border-t border-(--rule-color) pt-4 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => setPendingWorldId(null)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            onClick={() => {
              if (pendingWorld) enterWorld(pendingWorld.id);
            }}
          >
            {pendingWorld
              ? t("world.localeMismatchContinue", {
                  language: localeName(pendingWorld.locale),
                  defaultValue: "Continue in {{language}}",
                })
              : null}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  const deleteDialog = (
    <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
      <DialogContent
        className="max-w-sm"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || deleting) return;
          event.preventDefault();
          void handleDeleteConfirm();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("world.deleteConfirmTitle", "Delete world?")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "world.deleteConfirmDesc",
              'This will permanently delete "{{name}}". This action cannot be undone.',
              {
                name: deletingWorld
                  ? text(deletingWorld.name)
                  : deletingWorldId,
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={deleting}
            onClick={() => setDeleteConfirmOpen(false)}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleting}
            aria-keyshortcuts="Enter"
            onClick={() => void handleDeleteConfirm()}
          >
            {deleting
              ? t("common.deleting", "Deleting...")
              : t("world.deleteConfirmAction", "Delete")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (mode === "detail" && selectedWorld) {
    return (
      <>
        {localeMismatchDialog}
        {deleteDialog}
        <WorldDetailView
          world={selectedWorld}
          onClose={handleBack}
          onEdit={handleEditFromDetail}
          onDelete={
            isWorldDeletable(selectedWorld)
              ? () => handleDeleteFromDetail(selectedWorld.id)
              : undefined
          }
        />
      </>
    );
  }

  if (mode === "edit" && selectedWorld) {
    return (
      <WorldEditor
        world={selectedWorld}
        onSave={handleSave}
        onCancel={() => setMode("detail")}
      />
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {localeMismatchDialog}
      {deleteDialog}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={onSettingsOpenChange}
        initialKey={settingsInitialKey}
        packages={packages}
      />
      <AiWorldGenerator
        open={generatorOpen}
        onOpenChange={setGeneratorOpen}
        onWorldCreated={(world) => onWorldCreated?.(world)}
      />
      <WorldListView
        worlds={prioritizedWorlds}
        t={t}
        interfaceLocale={activeLocale ?? DEFAULT_FALLBACK_LOCALE}
        primarySlotLabel={primarySlotLabel}
        enabledPluginCount={enabledPluginCount}
        enteringWorldId={enteringWorldId}
        storageLabel={worldStorageLabel}
        onOpenGenerator={() => setGeneratorOpen(true)}
        onOpenSettings={() => onSettingsOpenChange(true)}
        onEnterWorld={handleEnterWorld}
        onViewDetails={handleViewDetails}
        onDeleteWorld={handleDeleteClick}
      />
    </div>
  );
}
