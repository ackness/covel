import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TranslateFn } from "@/i18n";
import {
  Database,
  FileCode,
  Gauge,
  Images,
  Monitor,
  PackagePlus,
  Palette,
  Plug,
  Puzzle,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { isDesktopApp } from "@/lib/desktop-bridge.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import {
  clearSettingsNavigation,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import {
  PluginSettingsSectionPane,
  type PluginSettingsSectionTarget,
} from "@/components/platform/plugin-settings-sections.js";
import { usePlatformUiSpecs } from "@/components/platform/use-session-platform-specs.js";
import { isOperatorTokenRequired } from "@/services/api/health.js";
import { getOperatorToken } from "@/services/session-credentials.js";
import {
  buildNavTree,
  filterNav,
  resolveSettingsNode,
  ADVANCED_NODE_ID,
  APPEARANCE_NODE_ID,
  DATA_NODE_ID,
  DEVELOPER_MODE_KEY,
  GENERAL_NODE_ID,
  MEDIA_LIBRARY_NODE_ID,
  OPERATOR_ACCESS_NODE_ID,
  PACKAGES_NODE_ID,
  PERMISSIONS_NODE_ID,
  RAW_CONFIG_NODE_ID,
  READING_KEYS,
  type NavNode,
} from "./navigation.js";
import { SettingWidget } from "./widgets/index.js";
import { SettingFieldList, SettingsPaneHeader } from "./pane-layout.js";
import { useSetting, useSettingsStore } from "./use-settings.js";
import { useSettingsWritable } from "./use-settings-save.js";
import { DataPane } from "./DataPane.js";
import { DesktopPane } from "./DesktopPane.js";
import { LlmSlotsPane } from "./panes/LlmSlotsPane.js";
import { LlmAdvancedPane } from "./panes/LlmAdvancedPane.js";
import { LlmPresetsPane } from "./panes/LlmPresetsPane.js";
import { PackagesPane } from "./panes/PackagesPane.js";
import { AppearancePane } from "./panes/AppearancePane.js";
import { OperatorAccessPane } from "./panes/OperatorAccessPane.js";
import { PermissionsPane } from "./panes/PermissionsPane.js";
import { PluginSettingsPane } from "./panes/PluginSettingsPane.js";
import { RawConfigPane } from "./panes/RawConfigPane.js";
import { MediaLibraryPane } from "./panes/MediaLibraryPane.js";
import type { PluginSummary } from "@/services/api.js";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deep-link target — either a nav node id ("llm.slots") or a setting key. */
  initialKey?: string;
  plugins?: readonly Pick<PluginSummary, "id" | "displayName">[];
}

const SECTION_GROUP_HEADER_ID: Readonly<Record<string, string>> = {
  general: "group.general",
  llm: "llm",
  plugins: "plugin",
  data: "group.saves",
  advanced: "group.advanced",
};

export function SettingsDialog({
  open,
  onOpenChange,
  initialKey,
  plugins = [],
}: SettingsDialogProps) {
  const store = useSettingsStore();
  const writable = useSettingsWritable();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const { settingsSection } = usePlatformUiSpecs(open);
  const { pendingSettingsNavigation } = usePlatformUiState();
  const [query, setQuery] = useState("");
  const desktop = isDesktopApp();
  const [storeRevision, setStoreRevision] = useState(0);
  const [developerMode] = useSetting<boolean>(DEVELOPER_MODE_KEY);
  // A plugin's pane is titled with its display name, never its id.
  const pluginDisplayNames = useMemo(
    () =>
      Object.fromEntries(
        plugins.map((plugin) => [plugin.id, plugin.displayName] as const),
      ),
    [plugins],
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

  const { tree, pluginSections } = useMemo(() => {
    const base = buildNavTree(store, {
      includeDesktop: desktop,
      // Shown while the server has not answered, and while a token is
      // stored here so that it can still be cleared.
      includeOperatorAccess:
        isOperatorTokenRequired() !== false || getOperatorToken() !== undefined,
      // A server that checks the operator token is shared, and a shared
      // server has no media library.
      includeMediaLibrary: isOperatorTokenRequired() !== true,
      developerMode: developerMode === true,
      locale: i18n.language,
      pluginDisplayNames,
    });

    const sectionMap = new Map<string, PluginSettingsSectionTarget>();
    const byHeader = new Map<string, Array<{ node: NavNode; order: number }>>();

    for (const entry of settingsSection) {
      for (const spec of entry.specs) {
        if (!spec.id || spec.webview) continue;
        const id = `plugin-section:${entry.pluginId}:${spec.id}`;
        const label =
          resolveDisplayText(spec.label, locale) || spec.id || entry.pluginId;
        const headerId =
          SECTION_GROUP_HEADER_ID[spec.sectionGroup ?? "plugins"] ?? "plugin";
        sectionMap.set(id, { pluginId: entry.pluginId, spec });
        const bucket = byHeader.get(headerId) ?? [];
        bucket.push({
          order: spec.order ?? 0,
          node: {
            id,
            label,
            kind: "plugin",
            parentId: headerId,
            children: [],
          },
        });
        byHeader.set(headerId, bucket);
      }
    }

    if (byHeader.size === 0) {
      return { tree: base, pluginSections: sectionMap };
    }

    const merged: NavNode[] = [];
    let currentHeaderId: string | undefined;
    const flushGroup = (headerId: string | undefined) => {
      if (!headerId) return;
      const extras = byHeader.get(headerId);
      if (!extras) return;
      extras.sort(
        (a, b) => a.order - b.order || a.node.label.localeCompare(b.node.label),
      );
      for (const item of extras) merged.push(item.node);
      byHeader.delete(headerId);
    };

    for (const node of base) {
      if (node.kind === "header") {
        flushGroup(currentHeaderId);
        currentHeaderId = node.id;
      }
      merged.push(node);
    }
    flushGroup(currentHeaderId);
    for (const leftovers of byHeader.values()) {
      for (const item of leftovers) merged.push(item.node);
    }

    return { tree: merged, pluginSections: sectionMap };
  }, [
    store,
    desktop,
    i18n.language,
    locale,
    open,
    storeRevision,
    pluginDisplayNames,
    developerMode,
    settingsSection,
  ]);
  const filtered = useMemo(
    () => filterNav(tree, query, i18n.language),
    [tree, query, i18n.language],
  );

  const selectableNodes = useMemo(
    () => filtered.filter(isSelectable),
    [filtered],
  );
  const firstSelectable = selectableNodes[0] ?? null;

  const [selected, setSelected] = useState<string>(() =>
    initialKey ? (resolveSettingsNode(tree, initialKey)?.id ?? "") : "",
  );
  const contentRef = useRef<HTMLElement>(null);
  const appliedInitialKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [selected]);

  useEffect(() => {
    if (!open) {
      appliedInitialKey.current = undefined;
      return;
    }
    if (initialKey && appliedInitialKey.current !== initialKey) {
      setQuery("");
      const target = resolveSettingsNode(tree, initialKey);
      if (target) {
        appliedInitialKey.current = initialKey;
        setSelected(target.id);
        return;
      }
    }
    if (!selected || !filtered.find((n) => n.id === selected)) {
      setSelected(firstSelectable?.id ?? "");
    }
  }, [open, initialKey, tree, filtered, firstSelectable, selected]);

  useEffect(() => {
    if (!open || !pendingSettingsNavigation) return;
    const target = resolveSettingsNode(tree, pendingSettingsNavigation.nodeId);
    clearSettingsNavigation(pendingSettingsNavigation.key);
    if (!target) return;
    setQuery("");
    setSelected(target.id);
  }, [open, pendingSettingsNavigation, tree]);

  const selectedNode: NavNode | null =
    filtered.find((n) => n.id === selected) ?? firstSelectable ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-workspace flex h-[calc(100dvh-1rem)] max-w-7xl flex-col gap-0 overflow-hidden p-0 md:h-[min(92dvh,64rem)]">
        <DialogHeader className="ui-workspace-rule ui-workspace-content flex min-h-16 justify-center text-left">
          <DialogTitle className="ui-title text-lg">
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("settings.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex min-w-0 shrink-0 flex-col border-b border-border bg-(--surface-rail) md:w-52 md:border-r md:border-b-0 lg:w-56">
            <div className="grid gap-(--ui-gap-inline) p-3 sm:grid-cols-2 md:block md:px-3.5 md:pt-4">
              <label htmlFor="settings-search" className="sr-only">
                {t("settings.searchPlaceholder")}
              </label>
              <div className="flex min-w-0 items-center gap-(--ui-gap-inline) rounded-md border border-border bg-background px-2.5 focus-within:ring-1 focus-within:ring-primary">
                <Search
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <input
                  id="settings-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("settings.searchPlaceholder")}
                  className="min-h-(--ui-control-touch) w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:min-h-(--ui-control-standard) sm:text-sm md:text-xs"
                />
              </div>
              <label htmlFor="settings-section" className="sr-only">
                {t("settings.title")}
              </label>
              <select
                id="settings-section"
                value={selectedNode?.id ?? ""}
                disabled={selectableNodes.length === 0}
                onChange={(event) => setSelected(event.target.value)}
                className="min-h-(--ui-control-touch) w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-base outline-none focus:ring-1 focus:ring-primary sm:min-h-(--ui-control-standard) sm:text-sm md:hidden"
              >
                {selectableNodes.length === 0 && (
                  <option value="">{t("settings.noResults", { query })}</option>
                )}
                {filtered
                  .filter((node) => node.kind === "header")
                  .map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {selectableNodes
                        .filter((node) => node.parentId === group.id)
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                {selectableNodes
                  .filter((node) => !node.parentId)
                  .map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.label}
                    </option>
                  ))}
              </select>
            </div>
            <nav
              aria-label={t("settings.title")}
              className="ui-scroll hidden min-h-0 flex-1 flex-col overflow-y-auto pb-4 md:flex"
            >
              {filtered.map((node) => {
                const isHeader = node.kind === "header";
                const isSelected = selected === node.id;
                if (isHeader) {
                  return (
                    <h3
                      key={node.id}
                      className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground"
                    >
                      {node.label}
                    </h3>
                  );
                }
                const Icon = navIcon(node);
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelected(node.id)}
                    aria-current={isSelected ? "page" : undefined}
                    className="ui-rail-item flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors aria-[current=page]:font-medium"
                  >
                    <Icon
                      aria-hidden
                      className={
                        "size-3.5 shrink-0 " +
                        (isSelected ? "text-(--accent-primary)" : "opacity-70")
                      }
                    />
                    <span className="min-w-0 wrap-break-word leading-snug">
                      {node.label}
                    </span>
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
            className="ui-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            <div className="ui-workspace-content @container mx-auto max-w-6xl py-(--ui-gap-section)">
              {!writable && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  {t("settings.loadFailedReadOnly")}
                </p>
              )}
              {renderPane(selectedNode, t, pluginSections, setSelected)}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  [GENERAL_NODE_ID]: SlidersHorizontal,
  [ADVANCED_NODE_ID]: Wrench,
  [APPEARANCE_NODE_ID]: Palette,
  "llm.slots": Workflow,
  "llm.providers": Plug,
  "llm.advanced": Gauge,
  [PACKAGES_NODE_ID]: PackagePlus,
  desktop: Monitor,
  [DATA_NODE_ID]: Database,
  [RAW_CONFIG_NODE_ID]: FileCode,
  [MEDIA_LIBRARY_NODE_ID]: Images,
  [OPERATOR_ACCESS_NODE_ID]: ShieldCheck,
  [PERMISSIONS_NODE_ID]: Shield,
};

function navIcon(node: NavNode): LucideIcon {
  return NAV_ICONS[node.id] ?? (node.kind === "plugin" ? Puzzle : Settings2);
}

/** Group headers title a group of panes and are not directly selectable. */
function isSelectable(node: NavNode): boolean {
  return node.kind !== "header";
}

function renderPane(
  node: NavNode | null,
  t: TranslateFn,
  pluginSections?: ReadonlyMap<string, PluginSettingsSectionTarget>,
  onNavigate?: (nodeId: string) => void,
) {
  if (!node) {
    return (
      <div className="text-xs text-muted-foreground">
        {t("settings.noGroupSelected")}
      </div>
    );
  }
  const dynamicSection = pluginSections?.get(node.id);
  if (dynamicSection) {
    return <PluginSettingsSectionPane section={dynamicSection} />;
  }
  if (node.id === "llm.slots") return <LlmSlotsPane />;
  if (node.id === "llm.providers")
    return <LlmPresetsPane onNavigate={onNavigate} />;
  if (node.id === "llm.advanced")
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("settings.advancedDesc")}
        />
        <LlmAdvancedPane />
      </>
    );
  if (node.id === DATA_NODE_ID)
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("settings.paneDataDescription")}
        />
        <DataPane />
      </>
    );
  if (node.id === RAW_CONFIG_NODE_ID)
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("settings.paneRawConfigDescription")}
        />
        <RawConfigPane />
      </>
    );
  if (node.id === MEDIA_LIBRARY_NODE_ID)
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("mediaLibrary.description")}
        />
        <MediaLibraryPane />
      </>
    );
  if (
    node.id === "desktop" ||
    node.id === APPEARANCE_NODE_ID ||
    node.id === OPERATOR_ACCESS_NODE_ID
  )
    return (
      <>
        <SettingsPaneHeader title={node.label} />
        {node.id === "desktop" ? (
          <DesktopPane />
        ) : node.id === APPEARANCE_NODE_ID ? (
          <AppearancePane />
        ) : (
          <OperatorAccessPane />
        )}
      </>
    );
  if (node.id === PERMISSIONS_NODE_ID)
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("settings.panePermissionsDescription")}
        />
        <PermissionsPane />
      </>
    );
  if (node.id === PACKAGES_NODE_ID)
    return <PackagesPane onNavigate={onNavigate} />;
  if (node.kind === "plugin")
    return (
      <>
        <SettingsPaneHeader
          title={node.label}
          description={t("settings.panePluginDescription")}
        />
        <PluginSettingsPane entries={node.children} />
      </>
    );

  if (node.id === GENERAL_NODE_ID || node.id === ADVANCED_NODE_ID) {
    return <EntryPane node={node} t={t} />;
  }
  if (node.children.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {t("settings.groupEmpty")}
      </div>
    );
  }
  return (
    <>
      <SettingsPaneHeader title={node.label} />
      <SettingFieldList>
        {node.children.map((entry) => (
          <SettingWidget key={entry.key} entry={entry} />
        ))}
      </SettingFieldList>
    </>
  );
}

/**
 * Preferences and Advanced list their registered entries. Preferences ends
 * with a Reading section; Advanced keeps the developer-mode switch first.
 */
function EntryPane({ node, t }: { node: NavNode; t: TranslateFn }) {
  const reading = node.children.filter((entry) => READING_KEYS.has(entry.key));
  const rest = node.children.filter((entry) => !READING_KEYS.has(entry.key));
  return (
    <>
      <SettingsPaneHeader
        title={node.label}
        description={t(
          node.id === GENERAL_NODE_ID
            ? "settings.paneGeneralDescription"
            : "settings.paneAdvancedDescription",
        )}
      />
      <SettingFieldList>
        {rest.map((entry) => (
          <SettingWidget key={entry.key} entry={entry} />
        ))}
      </SettingFieldList>
      {reading.length > 0 && (
        <section className="mt-6 max-w-2xl space-y-3">
          <h3 className="settings-section-title">
            {t("settings.readingHeading")}
          </h3>
          <SettingFieldList>
            {reading.map((entry) => (
              <SettingWidget key={entry.key} entry={entry} />
            ))}
          </SettingFieldList>
        </section>
      )}
    </>
  );
}
