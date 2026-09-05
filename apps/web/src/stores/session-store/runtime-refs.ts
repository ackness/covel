import { useEffect, useRef } from "react";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
import { clearDomainEventPreviews } from "@/stores/domain-event-preview-store.js";
import { clearAllStreamingText } from "@/stores/streaming-text-store.js";
import {
  clearNarrativeDeltaBuffer,
  type DeltaBufferRef,
  type DeltaRafRef,
} from "./sse-handler.js";
import type { SessionState } from "./types.js";

export interface MutableRef<T> {
  current: T;
}

export interface SessionRuntimeRefs {
  stateRef: MutableRef<SessionState>;
  sessionIdRef: MutableRef<string | null>;
  sessionGenerationRef: MutableRef<number>;
  runtimeKindRef: MutableRef<Map<string, string>>;
  deltaBufferRef: DeltaBufferRef;
  deltaRafRef: DeltaRafRef;
  lastBackfilledTurnIdRef: MutableRef<string | null>;
}

export function useSessionRuntimeRefs(state: SessionState): SessionRuntimeRefs {
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const sessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const publishedSessionIdRef = useRef<string | null>(null);
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  const deltaBufferRef = useRef<DeltaBufferRef["current"]>(new Map());
  const deltaRafRef = useRef<DeltaRafRef["current"]>(null);
  const lastBackfilledTurnIdRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      sessionGenerationRef.current += 1;
      sessionIdRef.current = null;
      publishedSessionIdRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const nextId = state.session?.id ?? null;
    const previousId = publishedSessionIdRef.current;
    if (previousId === nextId) return;
    publishedSessionIdRef.current = nextId;
    if (previousId) {
      clearDomainEventPreviews(previousId);
    }
    sessionIdRef.current = nextId;
    setActivePluginDataSession(nextId);
    clearNarrativeDeltaBuffer(deltaBufferRef, deltaRafRef);
    clearAllStreamingText();
  }, [state.session]);

  return {
    stateRef,
    sessionIdRef,
    sessionGenerationRef,
    runtimeKindRef,
    deltaBufferRef,
    deltaRafRef,
    lastBackfilledTurnIdRef,
  };
}
