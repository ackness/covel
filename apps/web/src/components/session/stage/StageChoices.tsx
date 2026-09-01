/**
 * Decision panel for stage mode. It keeps the context, current question,
 * suggested replies, and free-text composer in one continuous surface so a
 * player never has to infer what an isolated choice is responding to.
 */
import { clsx } from "clsx";
import { Loader2, Send } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  mergeChoices,
  type StageChoiceItem,
  type StageInteractionChoice,
} from "./stage-selectors.js";

export interface StageChoicesProps {
  readonly visible: boolean;
  readonly executing: boolean;
  readonly interactionChoices: readonly StageInteractionChoice[];
  readonly promptsNamespace: Readonly<Record<string, unknown>>;
  /** Current-story fallback for legacy scene-prompts rows without `recap`. */
  readonly fallbackRecap?: string;
  readonly locale: string;
  readonly onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  readonly onSendMessage: (text: string) => void;
}

const STAGGER_STEP_MS = 60;
const TWO_COLUMN_GROUP_SIZE = 4;

// Category labels arrive as localized display text with no semantic key.
// Cycling the four hues keeps adjacent suggestions visually distinguishable.
const CATEGORY_HUES = 4;

export function StageChoices({
  visible,
  executing,
  interactionChoices,
  promptsNamespace,
  fallbackRecap,
  locale,
  onSubmitInteraction,
  onSendMessage,
}: StageChoicesProps): ReactElement | null {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const { items, groups, context } = mergeChoices(
    interactionChoices,
    promptsNamespace,
    locale,
  );

  if (!visible) return null;

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || executing) return;
    onSendMessage(text);
    setDraft("");
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft("");
    }
  };

  const handleSelect = (item: StageChoiceItem) => {
    if (executing) return;
    setDraft("");
    if (item.kind === "interaction") {
      void onSubmitInteraction?.(
        item.blockId,
        item.turnId,
        item.interactionId,
        "choice",
        { selectedId: item.choiceId, selectedLabel: item.label },
        item.submitBehavior,
      );
      return;
    }
    onSendMessage(item.label);
  };

  const itemOrder = new Map(items.map((item, index) => [item.id, index]));
  const recap = context.recap ?? fallbackRecap;
  const decision =
    context.decision ??
    (context.scene
      ? t("stage.decisionFromScene", { scene: context.scene })
      : t("stage.decisionFallback"));

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4 md:px-8 md:pb-8"
      data-testid="stage-choices"
    >
      <section className="ui-stage-panel pointer-events-auto flex max-h-[62vh] w-full max-w-3xl flex-col overflow-hidden rounded-(--radius-card)">
        <div className="border-b border-border/50 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {context.scene && (
                <p className="mb-1 text-[10px] font-semibold tracking-[0.16em] text-(--accent-primary) uppercase">
                  {context.scene}
                </p>
              )}
              {recap && (
                <div>
                  <p className="mb-1 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                    {t("stage.recapLabel")}
                  </p>
                  <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                    {recap}
                  </p>
                </div>
              )}
              <div className={recap ? "mt-2" : undefined}>
                <p className="mb-1 text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                  {t("stage.decisionLabel")}
                </p>
                <p className="text-sm font-medium leading-relaxed">
                  {decision}
                </p>
              </div>
            </div>
            {executing && (
              <span
                className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
                aria-live="polite"
              >
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
                {t("stage.thinkingLabel")}
              </span>
            )}
          </div>
        </div>

        {groups.length > 0 && (
          <div className="min-h-0 overflow-y-auto px-3 py-3">
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.id}>
                  {group.prompt && group.prompt !== decision && (
                    <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">
                      {group.prompt}
                    </p>
                  )}
                  <div
                    className={clsx(
                      "grid gap-1.5",
                      group.items.length >= TWO_COLUMN_GROUP_SIZE
                        ? "sm:grid-cols-2"
                        : "grid-cols-1",
                    )}
                  >
                    {group.items.map((item) => {
                      const index = itemOrder.get(item.id) ?? 0;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={
                            executing ||
                            (item.kind === "interaction" &&
                              !onSubmitInteraction)
                          }
                          onClick={() => handleSelect(item)}
                          className="ui-stage-choice-item min-h-11 rounded-(--radius-control) border border-border/60 bg-background/35 px-3.5 py-2 text-left text-sm transition-colors hover:border-(--accent-primary) disabled:cursor-wait disabled:opacity-50"
                          style={{
                            animationDelay: `${index * STAGGER_STEP_MS}ms`,
                          }}
                        >
                          <span className="flex items-center justify-between gap-3">
                            <span className="min-w-0 flex-1">{item.label}</span>
                            {item.description && (
                              <span
                                className={clsx(
                                  "ui-stage-cat shrink-0",
                                  `ui-stage-cat-${index % CATEGORY_HUES}`,
                                )}
                              >
                                {item.description}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-border/50 px-3 py-2.5">
          <textarea
            rows={1}
            value={draft}
            disabled={executing}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder={t("stage.inputPlaceholder")}
            aria-label={t("stage.inputPlaceholder")}
            data-testid="stage-decision-input"
            className="max-h-24 min-h-11 flex-1 resize-none rounded-(--radius-control) border border-border/60 bg-background/35 px-3 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-(--accent-primary) disabled:cursor-wait disabled:opacity-50 md:text-sm"
          />
          <button
            type="button"
            onClick={submitDraft}
            disabled={executing || !draft.trim()}
            aria-label={t("stage.sendLabel")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--accent-primary) text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {executing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </section>
    </div>
  );
}
