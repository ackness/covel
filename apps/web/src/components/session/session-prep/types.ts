import type { ReactNode } from "react";
import type * as api from "@/services/api.js";

export interface SessionPrepScreenProps {
  world: api.WorldRecord;
  packages: api.PackageSummary[];
  presets: api.PresetSummary[];
  llmConfig?: api.LlmConfigResponse | null;
  onBack: () => void;
  onStart: (plugins?: string[]) => Promise<void> | void;
  onResume: (session: api.SessionRecord) => Promise<void> | void;
  onDeleteSession: (sessionId: string) => Promise<void>;
  settingsOpen: boolean;
  onSettingsOpenChange: (v: boolean) => void;
  settingsInitialKey?: string;
}

export type PrepSectionStatus = "idle" | "loading" | "success" | "error";

export interface CollapsibleCardHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  summary?: ReactNode;
}
