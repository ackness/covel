import React from "react";

import type { HostBlockRendererProps } from "./types.js";

export function ImageCardBlock({ block }: HostBlockRendererProps) {
  const data = block.data as {
    title?: string;
    imageUrl?: string;
    url?: string;
    uri?: string;
    alt?: string;
    caption?: string;
  };
  const src = data.imageUrl ?? data.url ?? data.uri ?? "";
  const alt = data.alt ?? data.title ?? "image";

  return (
    <div className="form-stack">
      <h3>{String(data.title ?? "Image")}</h3>
      {src ? <img src={src} alt={alt} /> : null}
      {data.caption ? <p className="empty-copy">{data.caption}</p> : null}
    </div>
  );
}
