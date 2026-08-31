import { Loader2, Send, Square } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import type { SessionSlashCommand } from "@covel/shared";
import type { SessionRecord } from "@/services/api.js";
import { resolveDisplayText } from "@/lib/i18n-text.js";
import { slashCommandUsage } from "./slash-command.js";
import type { CommandFeedback } from "./use-game-view-composer.js";

interface MessageComposerProps {
  t: TFunction;
  session: SessionRecord;
  executing: boolean;
  inputValue: string;
  composerBlocked: boolean;
  composerDisabled: boolean;
  /** The "begin adventure" hero is still waiting to be clicked. */
  awaitingBegin: boolean;
  onInputValueChange: (value: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  commandMatches?: readonly SessionSlashCommand[];
  commandMenuOpen?: boolean;
  selectedCommandIndex?: number;
  commandExecuting?: boolean;
  commandFeedback?: CommandFeedback | null;
  onCommandSelect?: (command: SessionSlashCommand) => void;
}

export function MessageComposer({
  t,
  session,
  executing,
  inputValue,
  composerBlocked,
  composerDisabled,
  awaitingBegin,
  onInputValueChange,
  onSubmit,
  onAbort,
  onKeyDown,
  commandMatches = [],
  commandMenuOpen = false,
  selectedCommandIndex = 0,
  commandExecuting = false,
  commandFeedback,
  onCommandSelect,
}: MessageComposerProps) {
  const selectedCommandRef = useRef<HTMLButtonElement>(null);
  const isPlaying = session.status === "active" && session.phase === "playing";
  const isEnded = session.status === "ended";

  useEffect(() => {
    if (!commandMenuOpen) return;
    selectedCommandRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [commandMenuOpen, selectedCommandIndex]);

  return (
    // `data-executing` / `data-blocked` are orthogonal: a turn can be running
    // (composer still usable — submitting steers it) while nothing blocks it.
    // E2E reads both instead of inferring turn state from `input:disabled`.
    <div
      data-testid="game-composer"
      data-executing={executing}
      data-blocked={composerBlocked}
      className="border-t border-(--rule-color) shrink-0 px-3 md:px-4 py-4 md:py-5 bg-(--surface-page)"
    >
      {isEnded ? (
        <p className="ui-empty-copy mx-auto text-center text-sm">
          {t("session.ended", "This session has ended.")}
        </p>
      ) : (
        <div className="ui-composer-frame relative mx-auto">
          {commandMenuOpen && (
            <div
              id="game-composer-command-list"
              role="listbox"
              aria-label={t("session.commandMenu", "Available commands")}
              className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) shadow-xl"
            >
              {commandMatches.length > 0 ? (
                <div className="max-h-72 overflow-y-auto p-1.5">
                  {commandMatches.map((command, index) => {
                    const selected = index === selectedCommandIndex;
                    return (
                      <button
                        id={`game-composer-command-${index}`}
                        key={command.id}
                        ref={selected ? selectedCommandRef : undefined}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          onCommandSelect?.(command);
                        }}
                        className={`flex w-full items-start gap-3 rounded-sm px-3 py-2 text-left transition-colors ${
                          selected
                            ? "bg-[color-mix(in_oklab,var(--accent-primary)_12%,transparent)] text-foreground"
                            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        }`}
                      >
                        <code className="mt-0.5 shrink-0 text-xs font-semibold text-(--accent-primary)">
                          /{command.name}
                        </code>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">
                            {resolveDisplayText(command.description)}
                          </span>
                          <span className="ui-meta mt-0.5 block truncate text-[9px] text-muted-foreground/70">
                            {slashCommandUsage(command)} ·{" "}
                            {resolveDisplayText(command.sourceLabel) ||
                              command.pluginId}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p
                  aria-live="polite"
                  className="px-3 py-3 text-xs text-muted-foreground"
                >
                  {t(
                    "session.commandNoMatch",
                    "No matching command. Enter sends it to the story pipeline.",
                  )}
                </p>
              )}
              {commandMatches[selectedCommandIndex] && (
                <div className="border-t border-(--rule-color) px-3 py-2 ui-meta text-[9px] text-muted-foreground/70">
                  <kbd className="ui-tag px-1 py-0">↑↓</kbd>{" "}
                  {t("session.commandNavigate", "navigate")} ·{" "}
                  <kbd className="ui-tag px-1 py-0">Tab</kbd>{" "}
                  {t("session.commandComplete", "complete")} ·{" "}
                  <kbd className="ui-tag px-1 py-0">Esc</kbd>{" "}
                  {t("session.commandDismiss", "dismiss")}
                </div>
              )}
            </div>
          )}
          <div className="ui-composer-input flex items-stretch rounded-(--radius-control) border border-(--rule-color) bg-(--surface-inset) focus-within:border-(--accent-primary) transition-colors">
            <input
              data-testid="game-composer-input"
              type="text"
              value={inputValue}
              onChange={(e) => onInputValueChange(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={commandMenuOpen}
              aria-controls={
                commandMenuOpen ? "game-composer-command-list" : undefined
              }
              aria-activedescendant={
                commandMenuOpen && commandMatches[selectedCommandIndex]
                  ? `game-composer-command-${selectedCommandIndex}`
                  : undefined
              }
              aria-label={t(
                "session.inputAriaLabel",
                "Story input — press Enter to send",
              )}
              placeholder={
                composerBlocked
                  ? t("session.composerBlockedPlaceholder")
                  : awaitingBegin
                    ? t("session.composerAwaitingBeginPlaceholder")
                    : executing
                      ? t("session.steerPlaceholder", "Interject mid-turn...")
                      : isPlaying
                        ? t(
                            "session.inputPlaceholder",
                            "Enter action or command...",
                          )
                        : t("session.inputPlaceholderAny", "Send a message...")
              }
              disabled={composerDisabled || commandExecuting}
              className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm outline-none disabled:opacity-50 placeholder:text-muted-foreground"
            />
            {executing && onAbort && (
              <button
                type="button"
                onClick={onAbort}
                aria-label={t("session.abortTurn", "Stop the current turn")}
                title={t("session.abortTurn", "Stop the current turn")}
                className="shrink-0 inline-flex items-center justify-center w-11 self-stretch border-l border-(--rule-color) text-muted-foreground hover:text-destructive hover:bg-[color-mix(in_oklab,var(--color-foreground)_6%,transparent)] transition-colors"
              >
                <Square className="w-3 h-3 animate-pulse" />
              </button>
            )}
            <button
              type="button"
              onClick={onSubmit}
              disabled={
                composerDisabled || commandExecuting || !inputValue.trim()
              }
              aria-label={
                executing
                  ? t("session.steerSend", "interject")
                  : t("session.inputKbdHint", "send")
              }
              className="shrink-0 inline-flex items-center justify-center w-11 self-stretch border-l border-(--rule-color) text-muted-foreground hover:text-foreground hover:bg-[color-mix(in_oklab,var(--color-foreground)_6%,transparent)] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
            >
              {commandExecuting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          {commandFeedback ? (
            <p
              role={commandFeedback.tone === "error" ? "alert" : "status"}
              className={`ui-meta px-1 mt-1.5 text-[10px] ${
                commandFeedback.tone === "error"
                  ? "text-destructive"
                  : "text-(--accent-primary)"
              }`}
            >
              {commandFeedback.message}
            </p>
          ) : composerBlocked ? (
            <p className="ui-meta text-[10px] text-muted-foreground/80 px-1 mt-1.5">
              {t("session.composerBlockedHint")}
            </p>
          ) : (
            <div className="hidden md:flex justify-end items-center gap-1.5 ui-meta text-[10px] text-muted-foreground/60 pr-1 mt-1.5 select-none">
              <kbd className="ui-tag px-1.5 py-0">{"\u23CE"}</kbd>
              <span>{t("session.inputKbdHint", "to send")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
