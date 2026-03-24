import React, { createElement, useMemo, useState } from "react";

import type { BlockEnvelope } from "../../../../modules/contracts/src/index.js";
import { dispatchActionWithSse } from "../actions/action-dispatcher.js";

export function InteractiveBlockForm(input: {
  runtimeBaseUrl: string;
  block: BlockEnvelope;
  sessionId: string;
  turnId: string;
  createRequestId(): string;
  onSubmitted?(blockId: string): void;
}) {
  const options = useMemo(
    () =>
      ((input.block.data as { options?: Array<{ id: string; label: string }> }).options ?? []),
    [input.block]
  );
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOptionId || submitted) {
      return;
    }

    await dispatchActionWithSse({
      runtimeBaseUrl: input.runtimeBaseUrl,
      action: {
        requestId: input.createRequestId(),
        type: "submit_block_response",
        sessionId: input.sessionId,
        payload: {
          blockId: input.block.id,
          blockType: input.block.type,
          sessionId: input.sessionId,
          turnId: input.turnId,
          response: {
            selected: selectedOptionId
          }
        }
      },
      onEnvelope() {}
    });

    setSubmitted(true);
    input.onSubmitted?.(input.block.id);
  }

  return createElement(
    "form",
    { className: "form-stack", onSubmit: handleSubmit },
    createElement("h3", null, String((input.block.data as { title?: string }).title ?? "Pending block")),
    ...options.map((option) =>
      createElement(
        "label",
        {
          key: option.id,
          className: "choice-row"
        },
        createElement("input", {
          type: "radio",
          name: input.block.id,
          value: option.id,
          "aria-label": option.label,
          checked: selectedOptionId === option.id,
          disabled: submitted,
          onChange: () => setSelectedOptionId(option.id)
        }),
        createElement("span", null, option.label)
      )
    ),
    createElement(
      "button",
      {
        className: "primary-button",
        type: "submit",
        disabled: submitted || !selectedOptionId
      },
      "Submit response"
    )
  );
}
