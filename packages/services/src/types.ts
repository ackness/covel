// ── ServiceGateway ──────────────────────────────────────────────────

export interface ServiceGateway {
  records: RecordQueryService;
  tables: TableService;
  scripts: ScriptHostService;
  references: ReferenceService;
  approvals: ApprovalService;
  tools: ToolGatewayService;
  settings: RuntimeSettingsService;
  trace: TraceService;
}

// ── RecordQueryService ──────────────────────────────────────────────

export interface RecordQueryService {
  query(input: RecordQueryInput): Promise<RecordQueryResult>;
}

export interface RecordQueryInput {
  sessionId: string;
  pluginId?: string;
  runtimeId?: string;
  status?: string[];
  recordType?: "runtime_result" | "domain_event" | "approval_record";
  limit?: number;
  cursor?: string | null;
}

export interface PublishedRecord {
  recordType: string;
  pluginId: string;
  runtimeId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  traceId: string;
  status: RecordStatus;
  timestamp: string;
  locale: string;
  payload: unknown;
  failureReason?: string;
}

export type RecordStatus =
  | "success"
  | "failed"
  | "approval_denied"
  | "skipped_condition"
  | "skipped_limit";

export interface RecordQueryResult {
  records: PublishedRecord[];
  nextCursor?: string;
}

// ── TableService ────────────────────────────────────────────────────

export interface TableService {
  query(input: TableQueryInput): Promise<unknown>;
  write(input: TableWriteInput): Promise<TableWriteResult>;
  patchSchema(input: TableSchemaPatchInput): Promise<TableSchemaPatchResult>;
}

export interface TableQueryInput {
  mode: "latest" | "history" | "diff";
  table: string;
  filters?: Record<string, unknown>;
  limit?: number;
  callerPluginId?: string;
  allowedPatterns?: string[];
  /** For history/diff: version identifiers. */
  fromVersion?: string;
  toVersion?: string;
}

export interface TableWriteInput {
  action: "insert" | "update" | "upsert" | "delete";
  table: string;
  key: string;
  data?: unknown;
  /** Runtime context for ownership check. */
  callerPluginId: string;
}

export interface TableWriteResult {
  success: boolean;
  version: string;
  error?: string;
}

export interface TableSchemaPatchInput {
  table: string;
  patch: Record<string, unknown>;
  callerPluginId: string;
  callerRuntimeId: string;
  runId: string;
}

export interface TableSchemaPatchResult {
  success: boolean;
  previousSchema?: Record<string, unknown>;
  newSchema?: Record<string, unknown>;
  error?: string;
}

// ── ScriptHostService ───────────────────────────────────────────────

export interface ScriptHostService {
  exec(input: ScriptExecInput): Promise<ScriptExecResult>;
}

export interface ScriptExecInput {
  /** Script filename relative to runtime's scripts/ directory. */
  script: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** Absolute path to the runtime's scripts/ directory. */
  scriptsDir: string;
}

export interface ScriptExecResult {
  success: boolean;
  output: unknown;
  durationMs: number;
  error?: string;
}

// ── ReferenceService ────────────────────────────────────────────────

export interface ReferenceService {
  load(input: ReferenceLoadInput): Promise<ReferenceLoadResult>;
}

export interface ReferenceLoadInput {
  /** Reference filename relative to runtime's references/ directory. */
  file: string;
  /** Absolute path to the runtime's references/ directory. */
  referencesDir: string;
}

export interface ReferenceLoadResult {
  content: string;
  sizeBytes: number;
}

// ── ApprovalService ─────────────────────────────────────────────────

export interface ApprovalService {
  check(input: ApprovalCheckInput): Promise<ApprovalDecision>;
  grant(input: ApprovalGrantInput): Promise<void>;
}

export interface ApprovalCheckInput {
  sessionId: string;
  pluginId: string;
  toolId: string;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason?: string;
}

export interface ApprovalGrantInput {
  sessionId: string;
  pluginId: string;
  toolId: string;
}

// ── ToolGatewayService ──────────────────────────────────────────────

export interface ToolGatewayService {
  listAvailable(runtimeId: string, pluginId: string): Promise<ResolvedToolDefinition[]>;
  invoke(input: ToolInvokeInput): Promise<ToolInvokeResult>;
}

export interface ResolvedToolDefinition {
  qualifiedId: string;
  pluginId: string;
  toolId: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  exported: boolean;
}

export interface ToolInvokeInput {
  qualifiedToolId: string;
  input: unknown;
  callerPluginId: string;
  callerRuntimeId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  locale: string;
}

export interface ToolInvokeResult {
  success: boolean;
  output: unknown;
  error?: string;
  interactionId?: string;
}

// ── RuntimeSettingsService ──────────────────────────────────────────

export interface RuntimeSettingsService {
  getResolved(sessionId: string, pluginId: string, runtimeId: string): Promise<Record<string, unknown>>;
  update(sessionId: string, pluginId: string, runtimeId: string, patch: Record<string, unknown>): Promise<void>;
}

// ── TraceService ────────────────────────────────────────────────────

export interface TraceService {
  append(entry: TraceEntry): Promise<void>;
}

export type TraceEntryKind =
  | "llm_input"
  | "llm_output"
  | "tool_call"
  | "tool_result"
  | "script_exec"
  | "script_result"
  | "approval_check"
  | "approval_decision"
  | "table_write"
  | "table_schema_change"
  | "domain_event"
  | "runtime_start"
  | "runtime_end"
  | "error";

export interface TraceEntry {
  kind: TraceEntryKind;
  sessionId: string;
  turnId: string;
  runId: string;
  traceId: string;
  pluginId: string;
  runtimeId: string;
  timestamp: string;
  data: unknown;
}

// ── Suspended Runtime Context ───────────────────────────────────────

export interface SuspendedRuntimeContext {
  interactionId: string;
  runtimeId: string;
  pluginId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  suspendedAt: string;
  interactionType: "approval" | "form" | "choice" | "confirm";
  pendingMessages: unknown[];
  pendingToolCalls: unknown[];
  timeoutMs: number;
}
