import React from "react";

import type { HostBlockRendererProps } from "./types.js";

export function DiceResultBlock({ block }: HostBlockRendererProps) {
  const data = block.data as {
    title?: string;
    formula?: string;
    roll?: number | string;
    total?: number | string;
    outcome?: string;
    detail?: string;
  };

  return (
    <div className="form-stack">
      <h3>{String(data.title ?? "Dice Result")}</h3>
      {data.formula ? <div className="workspace-meta">{data.formula}</div> : null}
      {data.roll !== undefined ? <div>{String(data.roll)}</div> : null}
      {data.total !== undefined ? <div>{String(data.total)}</div> : null}
      {data.outcome ? <div>{data.outcome}</div> : null}
      {data.detail ? <p className="empty-copy">{data.detail}</p> : null}
    </div>
  );
}
