import type { CharacterCard, RuntimeTriggerEvent } from "@covel/shared";
import type { TextMessage } from "@covel/ai-provider";

/** Proposal item from a runtime execution */
export interface ProposalItem {
  kind: string;
  payload: unknown;
}

/** Output from a completed runtime */
export interface RuntimeOutput {
  runtimeId: string;
  pluginId: string;
  narrative?: string;
  proposals: ProposalItem[];
  usage?: { inputTokens: number; outputTokens: number };
}

/** Static context initialized at turn start */
export interface TurnContextInit {
  runId: string;
  branchId: string;
  turnId: string;
  locale: string;
  world?: unknown;
  characters?: CharacterCard[];
  chat?: unknown;
  state: Record<string, unknown>;
  archive?: {
    activeVersion?: number;
    latestVersion?: number;
    summary?: string;
  };
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
}

/** Result of prompt assembly */
export interface PromptResult {
  messages: TextMessage[];
  tokenEstimate: number;
  sections: SectionMeta[];
}

/** Metadata about an included section (for observability) */
export interface SectionMeta {
  name: string;
  charCount: number;
  included: boolean;
}

/** Context fragment from a context provider */
export interface ContextFragment {
  id: string;
  pluginId: string;
  title: string;
  content: string;
  priority: number;
}
