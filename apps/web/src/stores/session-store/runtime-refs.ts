import { useEffect, useRef } from "react";
import { setActiveSession as setActivePluginDataSession } from "@/stores/plugin-data-store.js";
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
    const nextId = state.session?.id ?? null;
    if (sessionIdRef.current === nextId) return;
    sessionIdRef.current = nextId;
    setActivePluginDataSession(nextId);
    clearNarrativeDeltaBuffer(deltaBufferRef, deltaRafRef);
  }, [state.session]);

  return {
    stateRef,
    sessionIdRef,
    runtimeKindRef,
    deltaBufferRef,
    deltaRafRef,
    lastBackfilledTurnIdRef,
  };
}
