/**
 * Dialog box for stage mode (spec §2/§3 `StageDialog`). Owns the
 * typewriter state machine and reports "fully read" to the parent via
 * `onAllRead` so it can reveal the choice overlay. Doubles as the
 * free-text input surface once `inputMode` is toggled on — that toggle is
 * controlled by the parent, since the "✎" entry that turns it on lives in
 * `StageChoices`, a sibling component.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useTypewriter } from "./use-typewriter.js";

export interface StageDialogProps {
  readonly turnId?: string;
  readonly storyText: string;
  readonly streamEnded: boolean;
  readonly speakerName?: string;
  readonly autoPlay: boolean;
  readonly reducedMotion?: boolean;
  readonly inputMode: boolean;
  readonly onInputModeChange: (inputMode: boolean) => void;
  /** Fires once when the current turn's text has been fully revealed. */
  readonly onAllRead: () => void;
  readonly onSendMessage: (text: string) => void;
}

/** Auto-play dwell time at a paragraph break before advancing (spec §2). */
const AUTO_PLAY_PAUSE_MS = 1200;

export function StageDialog({
  turnId,
  storyText,
  streamEnded,
  speakerName,
  autoPlay,
  reducedMotion = false,
  inputMode,
  onInputModeChange,
  onAllRead,
  onSendMessage,
}: StageDialogProps): ReactElement {
  const { t } = useTranslation();
  const { visible, status, advance, skip } = useTypewriter(
    storyText,
    streamEnded,
    { turnId, reducedMotion },
  );
  const [draft, setDraft] = useState("");

  const prevStatusRef = useRef(status);
  useEffect(() => {
    const justFinished = status === "done" && prevStatusRef.current !== "done";
    prevStatusRef.current = status;
    if (justFinished) onAllRead();
  }, [status, onAllRead]);

  useEffect(() => {
    if (!autoPlay || status !== "pause") return;
    const id = setTimeout(advance, AUTO_PLAY_PAUSE_MS);
    return () => clearTimeout(id);
  }, [autoPlay, status, advance]);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    onSendMessage(text);
    setDraft("");
    onInputModeChange(false);
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft("");
      onInputModeChange(false);
    }
  };

  const handleFrameClick = () => {
    if (status === "pause") advance();
    else skip();
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 md:px-8 md:pb-8"
      data-testid="stage-dialog"
    >
      <div className="ui-stage-panel pointer-events-auto w-full max-w-3xl rounded-[var(--radius-card)]">
        {inputMode ? (
          <div className="flex flex-col gap-2 p-4">
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder={t("stage.inputPlaceholder")}
              className="resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {t("stage.inputSendHint")}
              </span>
              <Button size="sm" onClick={submitDraft} disabled={!draft.trim()}>
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleFrameClick}
            className="flex w-full flex-col gap-1.5 p-4 text-left"
          >
            {speakerName && (
              <span className="text-xs font-semibold text-[var(--accent-primary)]">
                {speakerName}
              </span>
            )}
            <p className="min-h-[3.6em] whitespace-pre-line text-sm leading-relaxed">
              {visible}
              {status === "pause" && (
                <span
                  className="ui-stage-caret ml-1 inline-block"
                  aria-hidden="true"
                >
                  ▼
                </span>
              )}
            </p>
          </button>
        )}
      </div>
    </div>
  );
}
