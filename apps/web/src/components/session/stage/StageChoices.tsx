/**
 * Choice overlay for stage mode (spec §2 `StageChoices`). Renders only
 * once the dialog has finished revealing (`visible`), merging pending
 * interaction choices with scene-prompts short phrases via `mergeChoices`;
 * the always-present "write your own" entry hands off to the parent,
 * which flips `StageDialog` into its input mode.
 */
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";
import {
  mergeChoices,
  type StageChoiceItem,
  type StageInteractionChoice,
} from "./stage-selectors.js";

export interface StageChoicesProps {
  readonly visible: boolean;
  readonly interactionChoices: readonly StageInteractionChoice[];
  readonly promptsNamespace: Readonly<Record<string, unknown>>;
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
  readonly onFreeInput: () => void;
}

const STAGGER_STEP_MS = 60;

// Category labels (观察/交涉/行动/追问) arrive as already-localized display text
// with no semantic key attached, so there's nothing to map a fixed color onto.
// Cycle the four `ui-stage-cat-*` hues by item index instead — the goal is only
// visual separation between adjacent choices.
const CATEGORY_HUES = 4;

export function StageChoices({
  visible,
  interactionChoices,
  promptsNamespace,
  locale,
  onSubmitInteraction,
  onSendMessage,
  onFreeInput,
}: StageChoicesProps): ReactElement | null {
  const { t } = useTranslation();
  if (!visible) return null;

  const { items, twoColumn } = mergeChoices(
    interactionChoices,
    promptsNamespace,
    locale,
  );

  const handleSelect = (item: StageChoiceItem) => {
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

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-32 z-40 flex justify-center px-4 md:bottom-40"
      data-testid="stage-choices"
    >
      <div
        className={clsx(
          "pointer-events-auto grid max-h-[46vh] w-full gap-1.5 overflow-y-auto",
          twoColumn ? "max-w-2xl" : "max-w-md",
          twoColumn ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => handleSelect(item)}
            className="ui-stage-panel ui-stage-choice-item rounded-(--radius-control) px-3.5 py-2 text-left text-sm transition-colors hover:border-(--accent-primary)"
            style={{ animationDelay: `${index * STAGGER_STEP_MS}ms` }}
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
        ))}
        <button
          type="button"
          onClick={onFreeInput}
          className="ui-stage-panel ui-stage-choice-item rounded-(--radius-control) px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-(--accent-primary)"
          style={{ animationDelay: `${items.length * STAGGER_STEP_MS}ms` }}
        >
          {t("stage.freeInputLabel")}
        </button>
      </div>
    </div>
  );
}
