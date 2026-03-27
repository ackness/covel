import { Streamdown } from "streamdown";

import type { TimelineItem } from "../types.js";

export interface MessageContentProps {
  content: string;
  role: TimelineItem["role"];
  streaming: boolean;
}

export function MessageContent({ content, role, streaming }: MessageContentProps) {
  if (role === "user") {
    return <div className="message-text">{content}</div>;
  }

  return (
    <Streamdown
      animated={streaming}
      className="message-markdown"
      isAnimating={streaming}
    >
      {content}
    </Streamdown>
  );
}
