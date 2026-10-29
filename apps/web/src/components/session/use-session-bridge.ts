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
  createSessionMessageOrdinals,
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
  const assignOrdinals = useMemo(
    () => createSessionMessageOrdinals(),
    [sessionId],
  );
  const messageSeqs = useMemo(
    () => assignOrdinals(messages),
    [assignOrdinals, messages],
  );
  const visible = useMemo(() => visibleSessionMessages(messages), [messages]);
  const placeholder = [...visible]
    .reverse()
    .find((message) => message.id.startsWith("stream_"));
  const current = useRef({
    placeholder,
    seq: placeholder ? (messageSeqs.get(placeholder.id) ?? 0) : 0,
  });
  current.current = {
    placeholder,
    seq: placeholder ? (messageSeqs.get(placeholder.id) ?? 0) : 0,
  };
  const lastRead = useRef<{ id: string; text: string } | null>(null);
  const stream = useMemo<StreamFeed>(
    () => ({
      subscribe: (listener) =>
        subscribeToStreamingChanges((change) => {
          if (change.messageId !== current.current.placeholder?.id) return;
          listener(change.type === "reset" ? "reset" : undefined);
        }),
      read: () => {
        const { placeholder: message, seq } = current.current;
        if (!message) {
          lastRead.current = null;
          return null;
        }
        // Completion can clear the cache before removing the placeholder;
        // retain its tail until then. A reset stores an explicit empty string
        // and invalidates the pump baseline, so discarded drafts never survive.
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
        messageSeqs,
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
    messageSeqs,
    submittedBlockIds,
    characters,
    slots,
    placeholder,
  ]);
  return { projection, stream };
}
