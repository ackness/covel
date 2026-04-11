/**
 * MessageList — renders all game messages via json-render.
 *
 * Every message type (narrative, player input, forms, notifications)
 * is converted to a json-render spec and rendered through the unified
 * component catalog. No hardcoded React rendering.
 */

import { useEffect, useRef, useMemo, useCallback, useState } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { messageToSpec, messageToSpecDisabled } from "@/lib/message-to-spec.js";
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
  const [submitted, setSubmitted] = useState(false);
  const formStateRef = useRef<Record<string, unknown>>({});

  const hasInteraction = Boolean(message.block);

  const spec = useMemo(() => {
    const nested = submitted && hasInteraction
      ? messageToSpecDisabled(message)
      : messageToSpec(message);
    if (!nested) return null;
    try {
      return nestedToFlat(nested);
    } catch {
      return null;
    }
  }, [message, submitted, hasInteraction]);

  const handleStateChange = useCallback((changes: Array<{ path: string; value: unknown }>) => {
    for (const { path, value } of changes) {
      formStateRef.current[path] = value;
    }
  }, []);

  const handlers = useMemo(() => ({
    submitForm: async () => {
      if (submitted) return;
      setSubmitted(true);

      // Extract form field values from tracked state
      const formValues: Record<string, string> = {};
      for (const [path, value] of Object.entries(formStateRef.current)) {
        // paths like "/form/characterName" → "characterName"
        const match = path.match(/^\/form\/(.+)$/);
        if (match && value) {
          formValues[match[1]] = String(value);
        }
      }

      // Build readable message from form values
      const parts = Object.entries(formValues)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}: ${v}`);

      const text = parts.length > 0
        ? parts.join(", ")
        : "(表单已提交)";

      sendMessage(text);
    },
    selectChoice: async (params: Record<string, unknown>) => {
      if (submitted) return;
      setSubmitted(true);
      const label = params.label as string;
      if (label) sendMessage(label);
    },
    selectSuggestion: async (params: Record<string, unknown>) => {
      const text = params.text as string;
      if (text) sendMessage(text);
    },
  }), [submitted]);

  if (!spec) return null;

  return (
    <JSONUIProvider
      registry={covelRegistry}
      initialState={{}}
      handlers={handlers}
      onStateChange={handleStateChange}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
  );
}
