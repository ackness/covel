import type {
  ApprovalRecord,
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PlayerInputRecord,
  PluginConfigRecord,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  SessionRecord,
  SessionSummaryRecord,
  SnapshotPayload,
  SnapshotRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
  SuspensionRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
} from "../types.js";

let seq = 0;

export function resetTestIds(): void {
  seq = 0;
}

export function id(): string {
  return `test-${++seq}`;
}

export function ts(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: id(),
    worldId: "world-1",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

export function makeTurnResult(
  overrides?: Partial<TurnResultRecord>,
): TurnResultRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: id(),
    runtimeResults: [],
    durationMs: 100,
    createdAt: ts(),
    ...overrides,
  };
}

export function makeRuntimeResult(
  overrides?: Partial<RuntimeResultRecord>,
): RuntimeResultRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginId: "plugin-1",
    runtimeId: "runtime-1",
    status: "success",
    output: { text: "hello" },
    toolCalls: [],
    durationMs: 50,
    createdAt: ts(),
    ...overrides,
  };
}

export function makeToolCall(
  overrides?: Partial<ToolCallRecordRow>,
): ToolCallRecordRow {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    toolName: "test-tool",
    pluginId: "plugin-1",
    runtimeId: "runtime-1",
    input: { foo: 1 },
    output: { bar: 2 },
    durationMs: 10,
    approvalStatus: "approved",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeStateSchema(
  overrides?: Partial<StateSchemaRecord>,
): StateSchemaRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    tableName: "stats",
    schema: { fields: ["hp", "mp"] },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeStateEntry(
  overrides?: Partial<StateEntryRecord>,
): StateEntryRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    tableName: "stats",
    fieldName: "hp",
    value: 100,
    updatedAt: ts(),
    ...overrides,
  };
}

export function makeStateChange(
  overrides?: Partial<StateChangeRecord>,
): StateChangeRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    tableName: "stats",
    fieldName: "hp",
    value: 80,
    changedBy: "combat",
    turnId: "turn-1",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeEvent(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    type: "domain",
    topic: "combat",
    payload: { damage: 20 },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeApproval(
  overrides?: Partial<ApprovalRecord>,
): ApprovalRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    toolName: "dangerous-tool",
    pluginId: "test-plugin",
    decision: "approved",
    turnId: "turn-1",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeMessage(overrides?: Partial<MessageRecord>): MessageRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    role: "assistant",
    content: "Hello, adventurer!",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeCharacter(
  overrides?: Partial<CharacterRecord>,
): CharacterRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    name: "Hero",
    type: "player",
    version: 1,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

export function makePluginConfig(
  overrides?: Partial<PluginConfigRecord>,
): PluginConfigRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    pluginId: "narrator",
    config: { tone: "dramatic" },
    updatedAt: ts(),
    ...overrides,
  };
}

export function makeWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: id(),
    name: "Test World",
    description: "A world for testing",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeTraceEvent(
  overrides?: Partial<TraceEventRecord>,
): TraceEventRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    type: "llm_call",
    traceId: "trace-1",
    turnId: "turn-1",
    payload: { model: "gpt-4" },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeRuntimeOutput(
  overrides?: Partial<RuntimeOutputRecord>,
): RuntimeOutputRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    runtimeResultId: id(),
    pluginId: "narrator",
    runtimeId: "narrator",
    timestamp: ts(),
    results: [
      { text: "hello world", structured: { narrative: "hello world" } },
    ],
    metaData: {
      turn: 0,
      toolCallList: [],
    },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeInteractionRecord(
  overrides?: Partial<InteractionRecordRow>,
): InteractionRecordRow {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    timestamp: ts(),
    source: "player",
    channel: "web",
    type: "message",
    payload: { content: "test" },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeTurnMessage(
  overrides?: Partial<TurnMessageRecord>,
): TurnMessageRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    sourceType: "runtime",
    role: "assistant",
    content: "test message",
    order: 500,
    createdAt: ts(),
    ...overrides,
  };
}

export function makePlayerInput(
  overrides?: Partial<PlayerInputRecord>,
): PlayerInputRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    formId: "test-form",
    values: { name: "test" },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeWorkingMemory(
  overrides?: Partial<WorkingMemoryRecord>,
): WorkingMemoryRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    key: "testKey",
    scope: "player",
    value: { data: "test" },
    updatedAt: ts(),
    ...overrides,
  };
}

export function makeWorldDataImportLedger(
  overrides?: Partial<WorldDataImportLedgerRecord>,
): WorldDataImportLedgerRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    target: "plugin-data",
    pluginId: "plugin-1",
    namespace: "world",
    key: "entry-1",
    sourceWorldId: "world-source",
    sourceId: "source-1",
    sourceDigest: "sha256:source",
    valueHash: "sha256:value",
    schemaRef: "schema://world-data/v1",
    derivedFrom: ["base-1"],
    importedAt: ts(),
    managed: true,
    ...overrides,
  };
}

export function makeSessionSummary(
  overrides?: Partial<SessionSummaryRecord>,
): SessionSummaryRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnRangeStart: "turn-1",
    turnRangeEnd: "turn-5",
    content: "The hero entered the dungeon and defeated a goblin.",
    focusSections: ["narrative", "character-state"],
    createdAt: ts(),
    ...overrides,
  };
}

export function makeSuspension(
  overrides?: Partial<SuspensionRecord>,
): SuspensionRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    runtimeId: "test-runtime",
    pluginId: "test-plugin",
    reason: "Need player input",
    resumeSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    pendingContinuation: {
      messages: [{ role: "system", content: "You are a test assistant." }],
      partialContent: undefined,
      toolCallsSoFar: [],
      pendingProposals: [],
      suspendToolCallId: "tc-suspend-1",
    },
    createdAt: ts(),
    resolvedAt: undefined,
    ...overrides,
  };
}

export function makeLorebookEntry(
  overrides?: Partial<LorebookEntryRecord>,
): LorebookEntryRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    pluginId: "plugin-1",
    keys: [],
    content: "Some lore content",
    strategy: "constant",
    position: "after_char_defs",
    insertionOrder: 100,
    enabled: true,
    extra: undefined,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

export function makeSnapshotPayload(
  overrides?: Partial<SnapshotPayload>,
): SnapshotPayload {
  return {
    schemaVersion: 1,
    turnId: "turn-1",
    characters: [],
    stateEntries: [],
    pluginData: [],
    workingMemory: [],
    lorebookEntries: [],
    suspensions: [],
    messagesCursor: "",
    ...overrides,
  };
}

export function makeSnapshot(
  overrides?: Partial<SnapshotRecord>,
): SnapshotRecord {
  return {
    id: id(),
    sessionId: "sess-1",
    turnId: "turn-1",
    kind: "manual",
    parentId: undefined,
    payload: makeSnapshotPayload(),
    createdAt: ts(),
    ...overrides,
  };
}
