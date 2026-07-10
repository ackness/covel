import { Send, Square } from "lucide-react";
import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { SessionRecord } from "@/services/api.js";

interface MessageComposerProps {
  t: TFunction;
  session: SessionRecord;
  executing: boolean;
  inputValue: string;
  composerBlocked: boolean;
  composerDisabled: boolean;
  onInputValueChange: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  onAbort?: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

export function MessageComposer({
  t,
  session,
  executing,
  inputValue,
  composerBlocked,
  composerDisabled,
  onInputValueChange,
  onSubmit,
  onAbort,
  onKeyDown,
}: MessageComposerProps) {
  const isPlaying = session.status === "active" && session.turnCount > 0;
  const isEnded = session.status === "ended";

  return (
    <div className="border-t border-[var(--rule-color)] shrink-0 px-3 md:px-4 py-4 md:py-5 bg-[var(--surface-page)]">
      {isEnded ? (
        <p className="ui-empty-copy mx-auto text-center text-sm">
          {t("session.ended", "This session has ended.")}
        </p>
      ) : (
        <div className="ui-composer-frame mx-auto">
          <div className="flex items-stretch rounded-[var(--radius-control)] border border-[var(--rule-color)] bg-[var(--surface-inset)] focus-within:border-[var(--accent-primary)] transition-colors">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => onInputValueChange(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label={t(
                "session.inputAriaLabel",
                "Story input — press Enter to send",
              )}
              placeholder={
                composerBlocked
                  ? t("session.composerBlockedPlaceholder")
                  : executing
                    ? t("session.steerPlaceholder", "Interject mid-turn...")
                    : isPlaying
                      ? t(
                          "session.inputPlaceholder",
                          "Enter action or command...",
                        )
                      : t("session.inputPlaceholderAny", "Send a message...")
              }
              disabled={composerDisabled}
              className="flex-1 min-w-0 px-3.5 py-2.5 bg-transparent text-sm outline-none disabled:opacity-50 placeholder:text-muted-foreground"
            />
            {executing && onAbort && (
              <button
                type="button"
                onClick={onAbort}
                aria-label={t("session.abortTurn", "Stop the current turn")}
                title={t("session.abortTurn", "Stop the current turn")}
                className="shrink-0 inline-flex items-center justify-center w-11 self-stretch border-l border-[var(--rule-color)] text-muted-foreground hover:text-destructive hover:bg-[color-mix(in_oklab,var(--color-foreground)_6%,transparent)] transition-colors"
              >
                <Square className="w-3 h-3 animate-pulse" />
              </button>
            )}
            <button
              type="button"
              onClick={onSubmit}
              disabled={composerDisabled || !inputValue.trim()}
              aria-label={
                executing
                  ? t("session.steerSend", "interject")
                  : t("session.inputKbdHint", "send")
              }
              className="shrink-0 inline-flex items-center justify-center w-11 self-stretch border-l border-[var(--rule-color)] text-muted-foreground hover:text-foreground hover:bg-[color-mix(in_oklab,var(--color-foreground)_6%,transparent)] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
          {composerBlocked ? (
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
