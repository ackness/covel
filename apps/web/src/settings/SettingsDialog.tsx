import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  buildNavTree,
  filterNav,
  APPEARANCE_NODE_ID,
  OPERATOR_ACCESS_NODE_ID,
  PACKAGES_NODE_ID,
  type NavNode,
} from "./navigation.js";
import { SettingWidget } from "./widgets/index.js";
import { useSettingsStore } from "./use-settings.js";
import { DataPane } from "./DataPane.js";
import { DesktopPane } from "./DesktopPane.js";
import { LlmSlotsPane } from "./panes/LlmSlotsPane.js";
import { LlmAdvancedPane } from "./panes/LlmAdvancedPane.js";
import { LlmPresetsPane } from "./panes/LlmPresetsPane.js";
import { PackagesPane } from "./panes/PackagesPane.js";
import { AppearancePane } from "./panes/AppearancePane.js";
import { OperatorAccessPane } from "./panes/OperatorAccessPane.js";
import type { PackageSummary } from "@/services/api.js";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deep-link target — either a nav node id ("llm.slots") or a setting key. */
  initialKey?: string;
  packages?: readonly Pick<PackageSummary, "name" | "displayName">[];
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialKey,
  packages = [],
}: SettingsDialogProps) {
  const store = useSettingsStore();
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const desktop = isDesktopApp();
  const [storeRevision, setStoreRevision] = useState(0);
  const pluginDisplayNames = useMemo(
    () =>
      Object.fromEntries(
        packages.map((pkg) => [pkg.name, pkg.displayName] as const),
      ),
    [packages],
  );

  useEffect(
    () =>
      store.subscribeAll(() => {
        setStoreRevision((value) => value + 1);
      }),
    [store],
  );

  useEffect(() => {
    setQuery("");
  }, [i18n.language]);

  const tree = useMemo(
    () =>
      buildNavTree(store, {
        includeDesktop: desktop,
        locale: i18n.language,
        pluginDisplayNames,
      }),
    // `open` included so the tree rebuilds when dialog opens and plugins
    // registered new entries since last render.
    [store, desktop, i18n.language, open, storeRevision, pluginDisplayNames],
  );
  const filtered = useMemo(
    () => filterNav(tree, query, i18n.language),
    [tree, query, i18n.language],
  );

  const selectableNodes = useMemo(
    () => filtered.filter(isSelectable),
    [filtered],
  );
  const firstSelectable = selectableNodes[0] ?? null;

  const [selected, setSelected] = useState<string>("");
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [selected]);

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
      <DialogContent className="h-[80vh] w-[calc(100%-1rem)] max-w-4xl gap-0 p-0 flex flex-col">
        <DialogHeader className="px-4 sm:px-6 pt-5 pb-4 border-b border-(--rule-color)">
          <DialogTitle className="flex items-baseline gap-3">
            <span className="ui-meta text-[10px] text-muted-foreground">
              § SETTINGS
            </span>
            <span className="ui-title text-base font-semibold tracking-tight">
              {t("settings.title")}
            </span>
            <Settings2 className="w-3.5 h-3.5 ml-auto opacity-50" />
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("settings.title")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
          <aside
            className="w-full sm:w-56 shrink-0 border-b sm:border-b-0 sm:border-r border-(--rule-color) flex flex-col"
            style={{ background: "var(--surface-rail)" }}
          >
            <div className="p-3 border-b border-(--rule-color) flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <label htmlFor="settings-search" className="sr-only">
                {t("settings.searchPlaceholder")}
              </label>
              <input
                id="settings-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.searchPlaceholder")}
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground min-w-0"
              />
            </div>
            <div className="p-3 sm:hidden">
              <label htmlFor="settings-section" className="sr-only">
                {t("settings.title")}
              </label>
              <select
                id="settings-section"
                value={selectedNode?.id ?? ""}
                disabled={selectableNodes.length === 0}
                onChange={(event) => setSelected(event.target.value)}
                className="w-full rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-(--accent-primary)"
              >
                {selectableNodes.length === 0 && (
                  <option value="">{t("settings.noResults", { query })}</option>
                )}
                {selectableNodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.label}
                  </option>
                ))}
              </select>
            </div>
            <nav
              aria-label={t("settings.title")}
              className="hidden sm:block flex-1 overflow-y-auto py-2 ui-scroll"
            >
              {filtered.map((node) => {
                const selectable = isSelectable(node);
                const indent = node.parentId ? "pl-9 " : "pl-4 ";
                const isHeader = node.kind === "group" && !selectable;
                const isSelected = selected === node.id;
                if (isHeader) {
                  return (
                    <h3
                      key={node.id}
                      className="ui-meta pl-4 pr-4 pt-4 pb-1 text-[10px] text-muted-foreground"
                    >
                      {node.label}
                    </h3>
                  );
                }
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelected(node.id)}
                    aria-current={isSelected ? "page" : undefined}
                    className={
                      "w-full text-left pr-4 py-1.5 text-xs transition-colors relative " +
                      indent +
                      (isSelected
                        ? "text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {isSelected && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-0 bottom-0 w-0.75"
                        style={{ background: "var(--accent-primary)" }}
                      />
                    )}
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
          <section
            ref={contentRef}
            className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 ui-scroll"
          >
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
  if (
    node.id === "llm.providers" ||
    node.id === "llm.keys" ||
    node.id === "llm.presets"
  ) {
    return <LlmPresetsPane />;
  }
  if (node.id === "llm.advanced") return <LlmAdvancedPane />;
  if (node.id === "data") return <DataPane />;
  if (node.id === "desktop") return <DesktopPane />;
  if (node.id === APPEARANCE_NODE_ID) return <AppearancePane />;
  if (node.id === OPERATOR_ACCESS_NODE_ID) return <OperatorAccessPane />;
  if (node.id === PACKAGES_NODE_ID) return <PackagesPane />;

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
