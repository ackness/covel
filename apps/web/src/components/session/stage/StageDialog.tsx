/**
 * Narrative dialog for stage mode. It owns only the typewriter state machine;
 * the following decision and composer live together in `StageChoices`.
 */
import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useTypewriter } from "./use-typewriter.js";

export interface StageDialogProps {
  readonly turnId?: string;
  readonly storyText: string;
  readonly streamEnded: boolean;
  readonly speakerName?: string;
  readonly autoPlay: boolean;
  readonly reducedMotion?: boolean;
  /** Fires once when the current turn's text has been fully revealed. */
  readonly onAllRead: () => void;
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
  onAllRead,
}: StageDialogProps): ReactElement {
  const { t } = useTranslation();
  const { visible, status, advance, skip } = useTypewriter(
    storyText,
    streamEnded,
    { turnId, reducedMotion },
  );

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

  const handleFrameClick = () => {
    if (status === "pause") advance();
    else skip();
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 md:px-8 md:pb-8"
      data-testid="stage-dialog"
    >
      <div className="ui-stage-panel pointer-events-auto relative w-full max-w-3xl rounded-(--radius-card)">
        <button
          type="button"
          onClick={handleFrameClick}
          aria-label={t("stage.advanceLabel")}
          className="flex w-full cursor-pointer flex-col gap-1.5 rounded-(--radius-card) p-4 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-foreground)_5%,transparent)]"
        >
          {speakerName && (
            <span className="ui-stage-panel absolute -top-3.5 left-4 rounded-full border-(--accent-primary) px-3.5 py-0.5 text-xs font-semibold text-(--accent-primary)">
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
      </div>
    </div>
  );
}
