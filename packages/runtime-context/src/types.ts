import type { ScopedEventBus, ScopedLogger } from "@covel/event-bus";
import type {
  RecordQueryService,
  TableService,
  ToolGatewayService,
  ScriptHostService,
  ReferenceService,
  ApprovalService,
  RecordStatus,
} from "@covel/services";

// ── RuntimeContext ───────────────────────────────────────────────────

export interface RuntimeContext {
  runtimeId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  locale: string;

  prompt: PromptAssemblyResult;
  settings: Record<string, unknown>;
  logger: ScopedLogger;
  bus: ScopedEventBus;

  records: RecordQueryService;
  tables: TableService;
  tools: ToolGatewayService;
  scripts: ScriptHostService;
  references: ReferenceService;
  approvals: ApprovalService;
}

// ── Prompt Assembly ─────────────────────────────────────────────────

export interface PromptAssemblyInput {
  /** Content of plugin/PLUGIN.md */
  pluginPrompt?: string;
  /** Content of runtime/instructions.md */
  instructions?: string;
  /** Current locale */
  locale: string;
  /** Resolved tool definitions for this runtime */
  toolDefinitions?: ToolDefinitionForPrompt[];
  /** Additional context (records snapshot, table snapshot, etc.) */
  contextSections?: ContextSection[];
}

export interface ToolDefinitionForPrompt {
  qualifiedId: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ContextSection {
  title: string;
  content: string;
  priority?: number;
}

export interface PromptAssemblyResult {
  /** Final assembled system prompt text. */
  systemPrompt: string;
  /** Individual sections (for debugging/trace). */
  sections: PromptSection[];
}

export interface PromptSection {
  label: string;
  content: string;
}

// ── Tool Execution Context ──────────────────────────────────────────

export interface ToolExecutionContext {
  pluginId: string;
  runtimeId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  locale: string;
  input: unknown;
}

// ── Runtime Execution Result ────────────────────────────────────────

export interface RuntimeExecutionResult {
  status: RecordStatus;
  payload: unknown;
  failureReason?: string;
}

// ── Structured Output ───────────────────────────────────────────────

export type StructuredOutputStrategy = "native" | "function_calling" | "prompt_retry";

export interface StructuredOutputConfig {
  /** JSON schema the output must conform to. */
  outputSchema: Record<string, unknown>;
  /** Preferred strategy order. Framework tries in sequence. */
  strategies?: StructuredOutputStrategy[];
  /** Max retries for prompt_retry strategy. */
  maxRetries?: number;
}

// ── RuntimeContext Factory Input ────────────────────────────────────

export interface RuntimeContextFactoryInput {
  runtimeId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  locale: string;
  settings: Record<string, unknown>;
  promptInput: PromptAssemblyInput;
  bus: ScopedEventBus;
  logger: ScopedLogger;
  records: RecordQueryService;
  tables: TableService;
  tools: ToolGatewayService;
  scripts: ScriptHostService;
  references: ReferenceService;
  approvals: ApprovalService;
}
