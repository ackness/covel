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

export interface SessionActionOwner {
  readonly requestId: string;
  readonly isCurrent: () => boolean;
}

/** Claim synchronously before any await; React's state mirror may still be stale. */
export function claimSessionAction(
  activeActionRef: MutableRef<symbol | null>,
  sessionIdRef: MutableRef<string | null>,
  sessionId: string,
  requestId: string = crypto.randomUUID(),
): SessionActionOwner {
  const token = Symbol("session-action");
  activeActionRef.current = token;
  return {
    requestId,
    isCurrent: () =>
      activeActionRef.current === token && sessionIdRef.current === sessionId,
  };
}

export interface SessionRuntimeRefs {
  stateRef: MutableRef<SessionState>;
  sessionIdRef: MutableRef<string | null>;
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
  const runtimeKindRef = useRef<Map<string, string>>(new Map());
  const deltaBufferRef = useRef<DeltaBufferRef["current"]>(new Map());
  const deltaRafRef = useRef<DeltaRafRef["current"]>(null);
  const lastBackfilledTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    const nextId =
      state.session?.id ??
      (state.executionRecovery?.hydrating
        ? state.executionRecovery.sessionId
        : null);
    if (sessionIdRef.current === nextId) return;
    if (sessionIdRef.current) {
      clearDomainEventPreviews(sessionIdRef.current);
    }
    sessionIdRef.current = nextId;
    setActivePluginDataSession(nextId);
    clearNarrativeDeltaBuffer(deltaBufferRef, deltaRafRef);
    clearAllStreamingText();
  }, [
    state.session,
    state.executionRecovery?.hydrating,
    state.executionRecovery?.sessionId,
  ]);

  return {
    stateRef,
    sessionIdRef,
    runtimeKindRef,
    deltaBufferRef,
    deltaRafRef,
    lastBackfilledTurnIdRef,
  };
}
