/**
 * MessageList — renders all game messages via json-render.
 *
 * Every message type (narrative, player input, forms, notifications)
 * is converted to a json-render spec and rendered through the unified
 * component catalog. No hardcoded React rendering.
 */

import { useEffect, useRef, useMemo, useCallback } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec } from "@/lib/message-to-spec.js";
import type { GameMessage } from "@/stores/session-store.js";
import { sendMessage } from "@/stores/session-store.js";

interface MessageListProps {
  messages: GameMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const visible = messages.filter((m) => m.content || m.block);

  return (
    <div className="space-y-4 pb-4">
      {visible.map((msg) => (
        <MessageRenderer key={msg.id} message={msg} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageRenderer({ message }: { message: GameMessage }) {
  const spec = useMemo(() => {
    const nested = messageToSpec(message);
    if (!nested) return null;
    try {
      return nestedToFlat(nested);
    } catch {
      return null;
    }
  }, [message]);

  const handleAction = useCallback((actionName: string, params?: Record<string, unknown>) => {
    if (actionName === "submitForm") {
      sendMessage("(表单已提交)");
    } else if (actionName === "selectChoice") {
      const label = params?.label as string;
      if (label) sendMessage(label);
    } else if (actionName === "selectSuggestion") {
      const text = params?.text as string;
      if (text) sendMessage(text);
    }
  }, []);

  if (!spec) return null;

  return (
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{}}
      handlers={{
        submitForm: async (params) => handleAction("submitForm", params),
        selectChoice: async (params) => handleAction("selectChoice", params),
        selectSuggestion: async (params) => handleAction("selectSuggestion", params),
      }}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
  );
}
