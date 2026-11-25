import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe2, Search, Settings, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { emitSettingsRequest, emitWorldListRequest } from "@/lib/nav-events.js";
import {
  closeCommandPalette,
  openPlatformTarget,
  toggleCommandPalette,
  usePlatformUiState,
} from "@/lib/platform-ui-events.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { emitToast } from "@/lib/toast-channel.js";
import type { AppCommandEntry } from "@/services/api.js";
import { postPluginRpcWithApproval } from "@/components/session/plugin-rpc-ui.js";
import { runPluginAppAction } from "./instance-panel-host.js";

interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly sourceLabel?: string;
  readonly shortcutHint?: string;
  readonly run: () => Promise<void> | void;
}

export function CommandPalette({
  appCommands,
  onNavigateWorlds,
}: {
  readonly appCommands: readonly AppCommandEntry[];
  readonly onNavigateWorlds?: () => void;
}) {
  const { commandPaletteOpen, activeSessionId, activeSessionCommands } =
    usePlatformUiState();
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [commandPaletteOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        id: "builtin:worlds",
        label: t("nav.world", "World"),
        description: t(
          "platform.commandWorldsDesc",
          "Browse and launch worlds",
        ),
        run: () => {
          emitWorldListRequest();
          onNavigateWorlds?.();
        },
      },
      {
        id: "builtin:settings",
        label: t("nav.settings", "Settings"),
        description: t(
          "platform.commandSettingsDesc",
          "Open application settings",
        ),
        run: () => {
          emitSettingsRequest();
        },
      },
    ];

    for (const cmd of appCommands) {
      if (cmd.palette === false) continue;
      const desc = resolveDisplayText(cmd.description, locale);
      const src = resolveDisplayText(cmd.sourceLabel, locale);
      list.push({
        id: cmd.id,
        label: `/${cmd.name}`,
        description: desc,
        sourceLabel: src,
        shortcutHint: cmd.shortcutHint,
        run: async () => {
          if (cmd.appAction) {
            await runPluginAppAction(cmd.pluginId, cmd.appAction, {});
          } else {
            openPlatformTarget(cmd.pluginId, cmd);
          }
        },
      });
    }

    if (activeSessionId) {
      for (const cmd of activeSessionCommands) {
        if (!cmd.palette) continue;
        if (list.some((item) => item.id === cmd.id)) continue;
        list.push({
          id: cmd.id,
          label: `/${cmd.name}`,
          description: resolveDisplayText(cmd.description, locale),
          sourceLabel: resolveDisplayText(cmd.sourceLabel, locale),
          shortcutHint: cmd.shortcutHint,
          run: async () => {
            if (openPlatformTarget(cmd.pluginId, cmd)) return;
            await postPluginRpcWithApproval({
              sessionId: activeSessionId,
              request: {
                kind: "command",
                commandId: cmd.id,
                input: `/${cmd.name}`,
              },
              pluginId: cmd.pluginId,
              actionLabel: `/${cmd.name}`,
              confirm: requestConfirm,
              t,
            });
          },
        });
      }
    }

    return list;
  }, [
    appCommands,
    activeSessionId,
    activeSessionCommands,
    locale,
    onNavigateWorlds,
    t,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false) ||
        (item.sourceLabel?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  const effectiveSelectedIndex =
    filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    closeCommandPalette();
    void Promise.resolve(item.run()).catch((err) => {
      emitToast("error", err instanceof Error ? err.message : String(err));
    });
  };

  if (!commandPaletteOpen) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeCommandPalette();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {t("platform.commandPaletteTitle", "Command palette")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex(
                  filtered.length === 0
                    ? 0
                    : (effectiveSelectedIndex + 1) % filtered.length,
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(
                  filtered.length === 0
                    ? 0
                    : (effectiveSelectedIndex - 1 + filtered.length) %
                        filtered.length,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                execute(filtered[effectiveSelectedIndex]);
              }
            }}
            placeholder={t(
              "platform.commandPalettePlaceholder",
              "Type a command or destination...",
            )}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("platform.commandPaletteEmpty", "No matching commands")}
            </p>
          ) : (
            filtered.map((item, idx) => {
              const Icon =
                item.id === "builtin:worlds"
                  ? Globe2
                  : item.id === "builtin:settings"
                    ? Settings
                    : Terminal;
              const selected = idx === effectiveSelectedIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => execute(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2.5 py-2 text-left text-sm transition-colors ${
                    selected ? "bg-muted text-foreground" : "hover:bg-muted/60"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.label}</div>
                      {item.description && (
                        <div className="truncate text-xs text-muted-foreground">
                          {item.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {item.sourceLabel && (
                      <span className="text-[11px] text-muted-foreground">
                        {item.sourceLabel}
                      </span>
                    )}
                    {item.shortcutHint && (
                      <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {item.shortcutHint}
                      </kbd>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
