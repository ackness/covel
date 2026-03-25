import React from "react";

import type { HostBlockRendererProps } from "./types.js";

export function SchemaFallbackBlock({ block }: HostBlockRendererProps) {
  return (
    <div className="form-stack">
      <h3>{block.type}</h3>
      <pre>{JSON.stringify(block.data, null, 2)}</pre>
    </div>
  );
}
