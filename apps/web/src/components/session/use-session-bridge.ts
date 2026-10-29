import { useMemo, useRef } from "react";
import { useSession } from "@/stores/session-store.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import {
  getStreamingText,
  subscribeToStreamingChanges,
} from "@/stores/streaming-text-store.js";
import {
  boundedSessionText,
  buildSessionProjection,
  sessionProjectionSchema,
  SESSION_BRIDGE_MAX_STREAM_BYTES,
  visibleSessionMessages,
} from "./session-bridge.js";
import type { StreamFeed } from "./session-bridge-stream.js";

const EMPTY_CHARACTERS: readonly unknown[] = [];
export function useSessionBridge(sessionId: string) {
  const { state } = useSession();
  const { session, messages, executing, submittedBlockIds } = state;
  const characters = Array.isArray(state.gameState.characters)
    ? state.gameState.characters
    : EMPTY_CHARACTERS;
  const slots = useUiSlots(sessionId);
  const warned = useRef(false);
  const visible = useMemo(() => visibleSessionMessages(messages), [messages]);
  const placeholder = [...visible]
    .reverse()
    .find((message) => message.id.startsWith("stream_"));
  const current = useRef({
    placeholder,
    seq: placeholder ? visible.indexOf(placeholder) + 1 : 0,
  });
  current.current = {
    placeholder,
    seq: placeholder ? visible.indexOf(placeholder) + 1 : 0,
  };
  const lastRead = useRef<{ id: string; text: string } | null>(null);
  const stream = useMemo<StreamFeed>(
    () => ({
      subscribe: subscribeToStreamingChanges,
      read: () => {
        const { placeholder: message, seq } = current.current;
        if (!message) {
          lastRead.current = null;
          return null;
        }
        // Clearing the text cache can precede the reducer removing the
        // placeholder. Retain its last text until then so the tail can flush.
        const cached =
          lastRead.current?.id === message.id
            ? lastRead.current.text
            : message.content;
        const text = boundedSessionText(
          getStreamingText(message.id) ?? cached,
          SESSION_BRIDGE_MAX_STREAM_BYTES,
        );
        lastRead.current = { id: message.id, text };
        return { seq, text };
      },
    }),
    [],
  );
  // Streaming updates stay on the imperative feed, without a React subscription.
  const projection = useMemo(() => {
    if (!session || session.id !== sessionId) return undefined;
    const result = sessionProjectionSchema.safeParse(
      buildSessionProjection({
        session,
        executing,
        messages,
        submittedBlockIds,
        streamingText: placeholder
          ? getStreamingText(placeholder.id)
          : undefined,
        characters,
        slots,
      }),
    );
    if (result.success) return result.data;
    if (!warned.current) {
      warned.current = true;
      console.warn(
        "[session-bridge] Invalid session projection; withholding state",
      );
    }
    return undefined;
  }, [
    session,
    sessionId,
    executing,
    messages,
    submittedBlockIds,
    characters,
    slots,
    placeholder,
  ]);
  return { projection, stream };
}
