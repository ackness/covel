import { createContext, useContext } from "react";
import type * as api from "@/services/api";
import type { PendingInteractionDraft, SessionState } from "./types.js";

export interface SessionActions {
  boot: () => Promise<void>;
  selectWorld: (worldId: string) => void;
  startGame: (plugins?: string[]) => Promise<void>;
  beginAdventure: () => void;
  resumeSession: (session: api.SessionRecord) => Promise<void>;
  resumeSessionById: (sessionId: string) => Promise<void>;
  loadWorldSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => void;
  /**
   * Interject into the in-flight turn (W4). Resolves false when no turn is
   * active — the composer restores the steered text for the player to re-send.
   */
  steerMessage: (content: string) => Promise<boolean>;
  /** Abort the in-flight turn (W4). No-op when nothing is running. */
  abortActiveTurn: () => Promise<void>;
  /**
   * Fetch the page of messages immediately older than the current window (from
   * `olderMessagesCursor`) and prepend them. No-op when the cursor is `null`
   * (start of history reached). Resolves once the store has been updated.
   */
  loadOlderMessages: () => Promise<void>;
  submitBlock: (blockId: string, values?: Record<string, unknown>) => void;
  submitInteraction: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  executeCommand: (command: string) => void;
  retryRuntime: (runtimeId?: string) => void;
  resetSession: () => void;
  backToWorldSelect: () => void;
  updateWorldLocal: (world: api.WorldRecord) => void;
  addWorldLocal: (world: api.WorldRecord) => void;
  removeWorldLocal: (worldId: string) => void;
  loadSessionPlugins: () => Promise<void>;
  toggleSessionPlugin: (pluginId: string, enable: boolean) => Promise<void>;
  triggerEvent: (eventType: string, eventData: Record<string, unknown>) => void;
  upsertInteractionDraft: (draft: PendingInteractionDraft) => void;
  removeInteractionDraft: (id: string) => void;
  clearInteractionDrafts: () => void;
  resumeSuspension: (suspensionId: string, data: unknown) => Promise<void>;
  cancelSuspension: (suspensionId: string) => Promise<void>;
  refreshSuspensions: () => Promise<void>;
}

export interface SessionContextValue extends SessionActions {
  state: SessionState;
}

/**
 * State and actions are split across two contexts so that components which
 * only call actions (e.g. interactive block handlers) do not re-render on
 * every streaming state change. `useSession()` stays as an aggregate hook for
 * backwards compatibility; prefer `useSessionActions()` in action-only
 * consumers to avoid the high-frequency state subscription.
 */
export const SessionStateContext = createContext<SessionState | null>(null);
export const SessionActionsContext = createContext<SessionActions | null>(null);

export function useSessionState(): SessionState {
  const ctx = useContext(SessionStateContext);
  if (!ctx)
    throw new Error("useSessionState must be used within SessionProvider");
  return ctx;
}

export function useSessionActions(): SessionActions {
  const ctx = useContext(SessionActionsContext);
  if (!ctx)
    throw new Error("useSessionActions must be used within SessionProvider");
  return ctx;
}

export function useSession(): SessionContextValue {
  const state = useSessionState();
  const actions = useSessionActions();
  return { state, ...actions };
}
