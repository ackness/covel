import React from "react";

import type { HostBlockRendererProps } from "./types.js";

export function ChoiceSetBlock({ block, onChoiceSelect }: HostBlockRendererProps) {
  const data = block.data as {
    title?: string;
    options?: Array<{
      id: string;
      label: string;
    }>;
  };

  return (
    <>
      <h3>{String(data.title ?? "Choices")}</h3>
      <div className="choice-grid">
        {(data.options ?? []).map((option) => (
          <button
            key={option.id}
            className="choice-button"
            onClick={() => onChoiceSelect?.(option.id)}
            disabled={!onChoiceSelect}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}
