/**
 * Reads a newly committed story one line at a time, like a visual novel's
 * text box: a nameplate for dialogue, progress, and a marker when more
 * follows. It heads the decision panel, so choices and input stay available
 * at every line; "Show all" or Escape switches to the whole story.
 */
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/ui/markdown.js";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  readerPageDelayMs,
  storyReaderUnits,
} from "./stage-dialogue-selectors.js";

export interface StageReaderProps {
  readonly sessionId?: string;
  readonly message: Pick<StreamMessage, "id" | "content" | "segments">;
  readonly autoPlay: boolean;
  readonly reducedMotion?: boolean;
  /** The speaking character of the current line, or undefined. */
  readonly onSpeakerChange?: (characterId: string | undefined) => void;
  /** The player read past the last line or asked for the whole story. */
  readonly onFinish: () => void;
}

const NEXT_KEYS = new Set([" ", "Enter", "ArrowRight", "PageDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "PageUp"]);

/** Keys typed into a field or pressed on a control belong to that element. */
function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName))
  );
}

export function StageReader({
  sessionId,
  message,
  autoPlay,
  reducedMotion = false,
  onSpeakerChange,
  onFinish,
}: StageReaderProps): ReactElement | null {
  const { t } = useTranslation();
  const units = useMemo(() => storyReaderUnits(message), [message]);
  const [index, setIndex] = useState(0);
  const unit = units[Math.min(index, units.length - 1)];
  const last = index >= units.length - 1;

  // Handlers read the latest position without re-subscribing every page.
  const latest = useRef({ index, last, onFinish });
  latest.current = { index, last, onFinish };
  const next = () => {
    if (latest.current.last) latest.current.onFinish();
    else setIndex(latest.current.index + 1);
  };
  const previous = () => setIndex(Math.max(0, latest.current.index - 1));

  useEffect(() => {
    if (units.length === 0) onFinish();
  }, [units.length, onFinish]);

  useEffect(() => {
    onSpeakerChange?.(unit?.speakerId);
  }, [unit?.speakerId, onSpeakerChange]);
  useEffect(() => () => onSpeakerChange?.(undefined), [onSpeakerChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        ownsKeys(event.target)
      )
        return;
      if (NEXT_KEYS.has(event.key)) next();
      else if (PREVIOUS_KEYS.has(event.key)) previous();
      else if (event.key === "Escape") latest.current.onFinish();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!autoPlay || !unit) return;
    const timer = setTimeout(next, readerPageDelayMs(unit.text));
    return () => clearTimeout(timer);
  }, [autoPlay, index, unit]);

  if (!unit) return null;
  return (
    <section
      className="border-b border-border/50 px-4 pt-5 pb-2"
      data-testid="stage-reader"
      aria-label={t("stage.readerLabel")}
    >
      <div className="relative">
        {unit.speaker && (
          <span
            data-testid="stage-reader-speaker"
            className="ui-stage-panel ui-stage-nameplate absolute -top-3.5 left-3 rounded-(--radius-card) px-3 py-0.5 text-sm font-semibold"
          >
            {unit.speaker}
          </span>
        )}
        <div
          role="button"
          tabIndex={0}
          aria-label={
            last ? t("stage.readerShowAll") : t("stage.nextParagraph")
          }
          onClick={next}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              next();
            }
          }}
          className="relative min-h-24 cursor-pointer rounded-(--radius-card) border border-border/60 px-4 pt-5 pb-6 text-left"
        >
          <div
            key={index}
            aria-live="polite"
            data-testid="stage-reader-line"
            data-narration={unit.narration || undefined}
            className={clsx(
              "text-base leading-relaxed",
              unit.narration && "text-muted-foreground",
              !reducedMotion && "ui-stage-line",
            )}
          >
            <Markdown themeSessionId={sessionId} themePart="dialogue">
              {unit.text}
            </Markdown>
          </div>
          {!last && (
            <ChevronDown
              aria-hidden="true"
              className="ui-stage-next-hint absolute right-4 bottom-3 h-4 w-4 text-(--accent-primary)"
            />
          )}
        </div>
        <nav
          data-covel-host-controls=""
          className="mt-1.5 flex items-center justify-end gap-3 px-1 text-xs text-muted-foreground"
        >
          {units.length > 1 && (
            <span data-testid="stage-reader-progress">
              {t("stage.readerProgress", {
                current: index + 1,
                total: units.length,
              })}
            </span>
          )}
          {index > 0 && (
            <button type="button" onClick={previous}>
              {t("stage.previousParagraph")}
            </button>
          )}
          <button
            type="button"
            data-testid="stage-reader-show-all"
            onClick={onFinish}
          >
            {t("stage.readerShowAll")}
          </button>
        </nav>
      </div>
    </section>
  );
}
