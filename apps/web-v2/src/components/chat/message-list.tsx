/**
 * MessageList — renders game messages (narrative, player input, blocks).
 */

import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import type { GameMessage } from "@/stores/session-store.js";
import { InteractionBlock } from "./interaction-block.js";

interface MessageListProps {
  messages: GameMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Filter out empty assistant messages (streaming placeholders that never got content)
  const visible = messages.filter((m) => m.content || m.block);

  return (
    <div className="space-y-4 pb-4">
      {visible.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: GameMessage }) {
  if (message.block) {
    return <InteractionBlock block={message.block} />;
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  // Assistant narrative
  if (!message.content) return null;

  return (
    <div className="max-w-[90%]">
      <div className="prose prose-sm dark:prose-invert prose-p:my-2 prose-p:leading-relaxed">
        {message.content.split("\n\n").map((paragraph, i) => (
          <p key={i} className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed">
            {paragraph}
          </p>
        ))}
      </div>
      {message.pluginId && (
        <span className="text-[9px] text-zinc-400 mt-1 block">
          {message.pluginId}
        </span>
      )}
    </div>
  );
}
