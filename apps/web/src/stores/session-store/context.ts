import { createContext, useContext } from "react";
import type * as api from "@/services/api";
import type { PendingInteractionDraft, SessionState } from "./types.js";

export interface SessionContextValue {
  state: SessionState;
  boot: () => Promise<void>;
  selectWorld: (worldId: string) => void;
  startGame: (plugins?: string[]) => Promise<void>;
  beginAdventure: () => void;
  resumeSession: (session: api.SessionRecord) => Promise<void>;
  resumeSessionById: (sessionId: string) => Promise<void>;
  loadWorldSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => void;
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
  setComposerText: (text: string) => void;
  resumeSuspension: (suspensionId: string, data: unknown) => Promise<void>;
  cancelSuspension: (suspensionId: string) => Promise<void>;
  refreshSuspensions: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
