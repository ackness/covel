import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Settings2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { isDesktopApp } from "@/lib/desktop-bridge.js";
import { buildNavTree, filterNav, type NavNode } from "./navigation.js";
import { SettingWidget } from "./widgets/index.js";
import { useSettingsStore } from "./use-settings.js";
import { DataPane } from "./DataPane.js";
import { DesktopPane } from "./DesktopPane.js";
import { LlmSlotsPane } from "./panes/LlmSlotsPane.js";
import { LlmKeysPane } from "./panes/LlmKeysPane.js";
import { LlmAdvancedPane } from "./panes/LlmAdvancedPane.js";
import { LlmPresetsPane } from "./panes/LlmPresetsPane.js";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deep-link target — either a nav node id ("llm.slots") or a setting key. */
  initialKey?: string;
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialKey,
}: SettingsDialogProps) {
  const store = useSettingsStore();
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const desktop = isDesktopApp();

  const tree = useMemo(
    () =>
      buildNavTree(store, { includeDesktop: desktop, locale: i18n.language }),
    // `open` included so the tree rebuilds when dialog opens and plugins
    // registered new entries since last render.
    [store, desktop, i18n.language, open],
  );
  const filtered = useMemo(
    () => filterNav(tree, query, i18n.language),
    [tree, query, i18n.language],
  );

  const firstSelectable = useMemo(
    () => filtered.find((n) => n.id !== "llm" && n.id !== "plugin") ?? null,
    [filtered],
  );

  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    if (initialKey) {
      const exact = filtered.find((n) => n.id === initialKey);
      if (exact && isSelectable(exact)) {
        setSelected(exact.id);
        return;
      }
      const byChild = filtered.find((n) =>
        n.children.some(
          (e) => e.key === initialKey || e.key.startsWith(initialKey),
        ),
      );
      if (byChild) {
        setSelected(byChild.id);
        return;
      }
    }
    if (!selected || !filtered.find((n) => n.id === selected)) {
      setSelected(firstSelectable?.id ?? "");
    }
  }, [open, initialKey, filtered, firstSelectable, selected]);

  const selectedNode: NavNode | null =
    filtered.find((n) => n.id === selected) ?? firstSelectable ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[80vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-sm uppercase tracking-widest">
            <Settings2 className="w-4 h-4" />
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("settings.title")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 flex overflow-hidden">
          <aside className="w-56 shrink-0 border-r border-border flex flex-col">
            <div className="p-2 border-b border-border flex items-center gap-1.5">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.searchPlaceholder")}
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground min-w-0"
              />
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {filtered.map((node) => {
                const selectable = isSelectable(node);
                const indent = node.parentId ? "pl-8 " : "";
                const isHeader = node.kind === "group" && !selectable;
                return (
                  <button
                    key={node.id}
                    type="button"
                    disabled={isHeader}
                    onClick={() => setSelected(node.id)}
                    className={
                      "w-full text-left px-4 py-1.5 text-xs transition-colors " +
                      indent +
                      (isHeader
                        ? "text-muted-foreground uppercase tracking-widest text-[10px] pt-3"
                        : selected === node.id
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-muted/50")
                    }
                  >
                    {node.label}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-4 py-2 text-xs text-muted-foreground">
                  {t("settings.noResults", { query })}
                </div>
              )}
            </nav>
          </aside>
          <section className="flex-1 overflow-y-auto p-5">
            {renderPane(selectedNode, t)}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Group headers ("llm", "plugin") are not directly selectable. */
function isSelectable(node: NavNode): boolean {
  if (node.id === "llm") return false;
  if (node.id === "plugin") return false;
  return true;
}

function renderPane(
  node: NavNode | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (!node) {
    return (
      <div className="text-xs text-muted-foreground">
        {t("settings.noGroupSelected")}
      </div>
    );
  }
  if (node.id === "llm.slots") return <LlmSlotsPane />;
  if (node.id === "llm.keys") return <LlmKeysPane />;
  if (node.id === "llm.presets") return <LlmPresetsPane />;
  if (node.id === "llm.advanced") return <LlmAdvancedPane />;
  if (node.id === "data") return <DataPane />;
  if (node.id === "desktop") return <DesktopPane />;

  if (node.children.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {t("settings.groupEmpty")}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {node.children.map((entry) => (
        <SettingWidget key={entry.key} entry={entry} />
      ))}
    </div>
  );
}
