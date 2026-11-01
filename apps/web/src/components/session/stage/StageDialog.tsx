import { storyParagraphSpeakers } from "./stage-dialogue-selectors.js";
/** A committed story reader. Paragraph navigation never controls execution or input. */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/ui/markdown.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { Reveal } from "@/lib/reveal/Reveal.js";
import { useStoryReveal } from "@/lib/reveal/story-reveal-context.js";
import {
  compileSegmentTemplates,
  planSegmentTemplates,
  segmentRevealPolicy,
} from "@/lib/segment-templates.js";

export interface StageDialogProps {
  readonly inline?: boolean;
  readonly sessionId?: string;
  readonly message: Pick<StreamMessage, "id" | "content" | "segments">;
  readonly autoPlay: boolean;
  readonly reducedMotion?: boolean;
}

export function StageDialog({
  inline = false,
  sessionId,
  message,
  autoPlay,
  reducedMotion = false,
}: StageDialogProps): ReactElement {
  const { t } = useTranslation();
  const admission = useStoryReveal(message);
  const state = useContext(SessionStateContext);
  const entries = state?.segmentUiSpecs;
  const policy = useMemo(
    () =>
      segmentRevealPolicy(
        planSegmentTemplates(
          compileSegmentTemplates(entries ?? []),
          message.segments ?? [],
        ),
      ),
    [entries, message.segments],
  );
  const paragraphs = useMemo(
    () =>
      message.segments?.map((segment) => segment.text).join("\n\n") ===
      message.content
        ? message.segments.map((segment) => segment.text)
        : [message.content],
    [message.content, message.segments],
  );
  const speakers = storyParagraphSpeakers(message);
  const structured =
    message.segments?.map((segment) => segment.text).join("\n\n") ===
    message.content;
  const [reader, setReader] = useState({
    id: message.id,
    index: 0,
    manual: false,
  });
  const index = reader.id === message.id ? reader.index : 0;
  const refs = useRef(new Map<number, HTMLElement>());
  const navigation = useRef<HTMLElement[]>([]);
  const [navigationCount, setNavigationCount] = useState(paragraphs.length);
  useLayoutEffect(() => {
    const rebuild = () => {
      const article = refs.current.get(0);
      navigation.current =
        paragraphs.length === 1 && article
          ? Array.from(article.children).filter(
              (node): node is HTMLElement =>
                node instanceof HTMLElement &&
                [
                  "P",
                  "PRE",
                  "UL",
                  "OL",
                  "BLOCKQUOTE",
                  "TABLE",
                  "H1",
                  "H2",
                  "H3",
                ].includes(node.tagName),
            )
          : [...refs.current.values()];
      if (!navigation.current.length && article) navigation.current = [article];
      setNavigationCount(navigation.current.length);
    };
    rebuild();
    const observer = new MutationObserver(rebuild);
    for (const article of refs.current.values())
      observer.observe(article, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [message.content, paragraphs]);
  const move = (next: number, manual = true) => {
    setReader({ id: message.id, index: next, manual });
    const node = navigation.current[next];
    // Scroll only the reader, so navigation never moves the composer or focus.
    const viewport = node?.parentElement?.closest("[data-stage-reader]");
    if (node && viewport instanceof HTMLElement)
      viewport.scrollTo?.({
        top: node.offsetTop - viewport.offsetTop,
        behavior: reducedMotion ? "auto" : "smooth",
      });
  };
  // Auto-play moves the reading position only. It cannot hide text or gate actions.
  useEffect(() => {
    if (!autoPlay || index >= navigationCount - 1) return;
    const timer = setTimeout(() => move(index + 1, false), 1200);
    return () => clearTimeout(timer);
  }, [autoPlay, index, message.id, navigationCount]);
  return (
    <section
      className={
        inline
          ? "relative"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center p-4"
      }
      data-testid="stage-dialog"
    >
      <div className="ui-stage-panel pointer-events-auto w-full max-w-3xl rounded-(--radius-card) p-4">
        <div
          className="max-h-52 overflow-y-auto overscroll-contain"
          data-stage-reader=""
        >
          <Reveal
            revealKey={message.id}
            {...admission}
            {...policy}
            active={
              admission.active &&
              !reducedMotion &&
              !(reader.id === message.id && reader.manual)
            }
          >
            {paragraphs.map((paragraph, position) => {
              const speaker = structured
                ? (speakers?.[position] ?? undefined)
                : undefined;
              return (
                <article
                  key={position}
                  ref={(node) => {
                    if (node) refs.current.set(position, node);
                    else refs.current.delete(position);
                  }}
                  data-stage-paragraph={position}
                  data-reader-current={index === position}
                  className="py-1.5 text-sm leading-relaxed"
                >
                  {speaker && (
                    <span
                      data-testid="stage-dialog-speaker"
                      className="font-semibold text-(--accent-primary)"
                    >
                      {speaker}
                    </span>
                  )}
                  <Markdown themeSessionId={sessionId} themePart="dialogue">
                    {paragraph}
                  </Markdown>
                </article>
              );
            })}
          </Reveal>
        </div>
        {navigationCount > 1 && (
          <nav
            data-covel-host-controls=""
            className="mt-2 flex flex-wrap gap-3 text-xs"
            aria-label={t("stage.readAgain")}
          >
            <button
              type="button"
              disabled={index === 0}
              onClick={() => move(index - 1)}
            >
              {t("stage.previousParagraph")}
            </button>
            <button
              type="button"
              disabled={index === navigationCount - 1}
              onClick={() => move(index + 1)}
            >
              {t("stage.nextParagraph")}
            </button>
            <button type="button" onClick={() => move(0)}>
              {t("stage.readAgain")}
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
