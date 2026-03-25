import React from "react";

import type { HostBlockRendererProps } from "./types.js";

export function AudioClipBlock({ block }: HostBlockRendererProps) {
  const data = block.data as {
    title?: string;
    audioUrl?: string;
    url?: string;
    uri?: string;
    transcript?: string;
  };
  const src = data.audioUrl ?? data.url ?? data.uri ?? "";

  return (
    <div className="form-stack">
      <h3>{String(data.title ?? "Audio")}</h3>
      {src ? <audio controls src={src} /> : null}
      {data.transcript ? <p className="empty-copy">{data.transcript}</p> : null}
    </div>
  );
}
