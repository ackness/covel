import { createContext, type ReactNode } from "react";

/** Host render slots only. Never add session records, stores or credentials here. */
export interface PluginViewSession {
  readonly sessionId: string;
  readonly renderMessages: (content: "story" | "pending") => ReactNode;
  readonly renderComposer: () => ReactNode;
}

export const PluginViewSessionContext = createContext<PluginViewSession | null>(
  null,
);
