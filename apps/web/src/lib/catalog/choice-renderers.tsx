import type { ComponentRenderer } from "@json-render/react";
import { useI18nResolver } from "./helpers.js";
import { useActionFeedback } from "./use-action-feedback.js";

/**
 * Options the player picks between. A plugin declares what the options are;
 * how they look — a numbered list, key-capped rows, a grid of cards — is the
 * active theme's decision through the `.ui-choice*` hooks. The position
 * marker is a CSS counter, so it follows whichever options are visible.
 */
export const ChoiceList: ComponentRenderer = ({ children }) => (
  <div role="group" className="ui-choice-list">
    {children}
  </div>
);

/**
 * One option. `title` is what the player would do; `description` and `tag`
 * are optional; `tone` hints the tag's colour. The click binding decides what
 * choosing does (queue a draft, send, call a runtime).
 */
export const Choice: ComponentRenderer = ({ element, emit }) => {
  const resolve = useI18nResolver();
  const title = resolve(element.props?.title);
  const description = resolve(element.props?.description);
  const tag = resolve(element.props?.tag);
  const tone =
    typeof element.props?.tone === "string" ? element.props.tone : undefined;
  const { isSelected, isPending } = useActionFeedback(element.on?.click);

  if (!title) return null;
  return (
    <button
      type="button"
      className="ui-choice"
      onClick={() => emit("click")}
      disabled={isPending || undefined}
      aria-pressed={isSelected || undefined}
      aria-busy={isPending || undefined}
      data-selected={isSelected ? "true" : undefined}
      data-tone={tone}
    >
      <span aria-hidden="true" className="ui-choice-index" />
      <span className="ui-choice-content">
        <span className="ui-choice-title">{title}</span>
        {description && <span className="ui-choice-body">{description}</span>}
      </span>
      {tag && <span className="ui-choice-eyebrow">{tag}</span>}
    </button>
  );
};
