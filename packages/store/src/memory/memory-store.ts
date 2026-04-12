/**
 * In-memory DataStore implementation.
 * Used for testing and ephemeral sessions.
 */

import type { PaginationOpts } from '../types.js';

function applyPagination<T>(items: T[], pagination?: PaginationOpts): T[] {
  if (!pagination) return items;
  const offset = pagination.offset ?? 0;
  const limit = pagination.limit;
  if (limit !== undefined) return items.slice(offset, offset + limit);
  if (offset > 0) return items.slice(offset);
  return items;
}

import type {
  DataStore,
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginDataRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
} from '../types.js';
import type {
  VectorStoreCapability,
  UpsertVectorInput,
  SearchVectorsInput,
  VectorSearchResult,
  DeleteVectorsInput,
} from '../vector-store.js';

/** In-memory vector row. Mutable — this is only for dev/test. */
interface MemoryVectorRow {
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  dimensions: number;
  embedding: Float32Array;
  payload: string | null;
}

function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function createMemoryStore(): DataStore & VectorStoreCapability {
  const sessions = new Map<string, SessionRecord>();
  const turnResults: TurnResultRecord[] = [];
  const runtimeResults: RuntimeResultRecord[] = [];
  const toolCalls: ToolCallRecordRow[] = [];
  const stateSchemas: StateSchemaRecord[] = [];
  const stateEntries = new Map<string, StateEntryRecord>();
  const stateChanges: StateChangeRecord[] = [];
  const events: EventRecord[] = [];
  const approvals: ApprovalRecord[] = [];
  const messages: MessageRecord[] = [];
  const characters = new Map<string, CharacterRecord>();
  const pluginData = new Map<string, PluginDataRecord>();
  const pluginConfigs = new Map<string, PluginConfigRecord>();
  const suspensions = new Map<string, SuspensionRecord>();
  /** Keyed by `${sessionId}:${pluginId}:${namespace}:${key}:${dim}` so
   *  multiple dims can coexist for the same logical row if a caller ever
   *  re-embeds with a different model. */
  const vectorRows = new Map<string, MemoryVectorRow>();
  const worlds = new Map<string, WorldRecord>();
  const traceEvents: TraceEventRecord[] = [];
  const turnMessages: TurnMessageRecord[] = [];
  const playerInputs: PlayerInputRecord[] = [];
  const workingMemoryEntries = new Map<string, WorkingMemoryRecord>();
  const sessionSummaries: SessionSummaryRecord[] = [];

  function stateEntryKey(sessionId: string, tableName: string, fieldName: string): string {
    return `${sessionId}:${tableName}:${fieldName}`;
  }

  function pluginDataKey(sessionId: string, pluginId: string, namespace: string, key: string): string {
    return `${sessionId}:${pluginId}:${namespace}:${key}`;
  }

  function pluginConfigKey(sessionId: string, pluginId: string): string {
    return `${sessionId}:${pluginId}`;
  }

  function workingMemoryKey(sessionId: string, scope: string, key: string): string {
    return `${sessionId}:${scope}:${key}`;
  }

  function vectorRowKey(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
    dimensions: number,
  ): string {
    return `${sessionId}:${pluginId}:${namespace}:${key}:${dimensions}`;
  }

  // ── Transaction snapshot state (S4-T1) ──
  //
  // On beginTx() we structurally clone every collection into `snapshot`.
  // On rollbackTx() we clear each collection and refill it from the snapshot.
  // On commitTx() we simply discard the snapshot.
  //
  // We deliberately use eager (not lazy-per-table) snapshotting: MemoryStore is
  // dev/test only, data volumes are small, and eager cloning keeps the bookkeeping
  // trivial. Vector rows are included so transactional commits also roll back
  // embedding upserts.
  interface MemorySnapshot {
    readonly sessions: Map<string, SessionRecord>;
    readonly turnResults: TurnResultRecord[];
    readonly runtimeResults: RuntimeResultRecord[];
    readonly toolCalls: ToolCallRecordRow[];
    readonly stateSchemas: StateSchemaRecord[];
    readonly stateEntries: Map<string, StateEntryRecord>;
    readonly stateChanges: StateChangeRecord[];
    readonly events: EventRecord[];
    readonly approvals: ApprovalRecord[];
    readonly messages: MessageRecord[];
    readonly characters: Map<string, CharacterRecord>;
    readonly pluginData: Map<string, PluginDataRecord>;
    readonly pluginConfigs: Map<string, PluginConfigRecord>;
    readonly vectorRows: Map<string, MemoryVectorRow>;
    readonly worlds: Map<string, WorldRecord>;
    readonly traceEvents: TraceEventRecord[];
    readonly turnMessages: TurnMessageRecord[];
    readonly playerInputs: PlayerInputRecord[];
    readonly workingMemoryEntries: Map<string, WorkingMemoryRecord>;
    readonly sessionSummaries: SessionSummaryRecord[];
    readonly suspensions: Map<string, SuspensionRecord>;
  }

  let snapshot: MemorySnapshot | null = null;

  function cloneVectorRows(
    src: Map<string, MemoryVectorRow>,
  ): Map<string, MemoryVectorRow> {
    // structuredClone does not clone Float32Array view semantics the way we
    // want across Map boundaries in older runtimes, so we do it by hand. The
    // other fields are primitives or nullable strings.
    const out = new Map<string, MemoryVectorRow>();
    for (const [k, row] of src) {
      out.set(k, {
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        namespace: row.namespace,
        key: row.key,
        dimensions: row.dimensions,
        embedding: new Float32Array(row.embedding),
        payload: row.payload,
      });
    }
    return out;
  }

  function captureSnapshot(): MemorySnapshot {
    return {
      sessions: structuredClone(sessions),
      turnResults: structuredClone(turnResults),
      runtimeResults: structuredClone(runtimeResults),
      toolCalls: structuredClone(toolCalls),
      stateSchemas: structuredClone(stateSchemas),
      stateEntries: structuredClone(stateEntries),
      stateChanges: structuredClone(stateChanges),
      events: structuredClone(events),
      approvals: structuredClone(approvals),
      messages: structuredClone(messages),
      characters: structuredClone(characters),
      pluginData: structuredClone(pluginData),
      pluginConfigs: structuredClone(pluginConfigs),
      vectorRows: cloneVectorRows(vectorRows),
      worlds: structuredClone(worlds),
      traceEvents: structuredClone(traceEvents),
      turnMessages: structuredClone(turnMessages),
      playerInputs: structuredClone(playerInputs),
      workingMemoryEntries: structuredClone(workingMemoryEntries),
      sessionSummaries: structuredClone(sessionSummaries),
      suspensions: structuredClone(suspensions),
    };
  }

  function restoreSnapshot(snap: MemorySnapshot): void {
    sessions.clear();
    for (const [k, v] of snap.sessions) sessions.set(k, v);
    turnResults.length = 0;
    turnResults.push(...snap.turnResults);
    runtimeResults.length = 0;
    runtimeResults.push(...snap.runtimeResults);
    toolCalls.length = 0;
    toolCalls.push(...snap.toolCalls);
    stateSchemas.length = 0;
    stateSchemas.push(...snap.stateSchemas);
    stateEntries.clear();
    for (const [k, v] of snap.stateEntries) stateEntries.set(k, v);
    stateChanges.length = 0;
    stateChanges.push(...snap.stateChanges);
    events.length = 0;
    events.push(...snap.events);
    approvals.length = 0;
    approvals.push(...snap.approvals);
    messages.length = 0;
    messages.push(...snap.messages);
    characters.clear();
    for (const [k, v] of snap.characters) characters.set(k, v);
    pluginData.clear();
    for (const [k, v] of snap.pluginData) pluginData.set(k, v);
    pluginConfigs.clear();
    for (const [k, v] of snap.pluginConfigs) pluginConfigs.set(k, v);
    vectorRows.clear();
    for (const [k, v] of snap.vectorRows) vectorRows.set(k, v);
    worlds.clear();
    for (const [k, v] of snap.worlds) worlds.set(k, v);
    traceEvents.length = 0;
    traceEvents.push(...snap.traceEvents);
    turnMessages.length = 0;
    turnMessages.push(...snap.turnMessages);
    playerInputs.length = 0;
    playerInputs.push(...snap.playerInputs);
    workingMemoryEntries.clear();
    for (const [k, v] of snap.workingMemoryEntries) workingMemoryEntries.set(k, v);
    sessionSummaries.length = 0;
    sessionSummaries.push(...snap.sessionSummaries);
    suspensions.clear();
    for (const [k, v] of snap.suspensions) suspensions.set(k, v);
  }

  const store: DataStore & VectorStoreCapability = {
    // ── Session ──

    async createSession(session) {
      sessions.set(session.id, session);
    },

    async getSession(id) {
      return sessions.get(id) ?? null;
    },

    async updateSession(id, patch) {
      const existing = sessions.get(id);
      if (!existing) return;
      sessions.set(id, { ...existing, ...patch });
    },

    async listSessions() {
      return [...sessions.values()];
    },

    async deleteSession(id) {
      sessions.delete(id);
      // Cascade delete all session-scoped data
      const filterArr = <T extends { sessionId: string }>(arr: T[]): void => {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].sessionId === id) arr.splice(i, 1);
        }
      };
      filterArr(turnResults);
      filterArr(runtimeResults);
      filterArr(toolCalls);
      filterArr(stateSchemas);
      filterArr(stateChanges);
      filterArr(events);
      filterArr(approvals);
      filterArr(messages);
      filterArr(traceEvents);
      filterArr(turnMessages);
      filterArr(playerInputs);
      filterArr(sessionSummaries);
      for (const [k, v] of stateEntries) { if (v.sessionId === id) stateEntries.delete(k); }
      for (const [k, v] of characters) { if (v.sessionId === id) characters.delete(k); }
      for (const [k, v] of pluginData) { if (v.sessionId === id) pluginData.delete(k); }
      for (const [k, v] of pluginConfigs) { if (v.sessionId === id) pluginConfigs.delete(k); }
    },

    // ── Turn Results ──

    async saveTurnResult(record) {
      turnResults.push(record);
    },

    async getTurnResult(sessionId, turnId) {
      return (
        turnResults.find((r) => r.sessionId === sessionId && r.turnId === turnId) ?? null
      );
    },

    async listTurnResults(sessionId, limit?) {
      const filtered = turnResults
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },

    // ── Runtime Results ──

    async saveRuntimeResult(record) {
      runtimeResults.push(record);
    },

    async listRuntimeResults(sessionId, turnId) {
      return runtimeResults.filter(
        (r) => r.sessionId === sessionId && r.turnId === turnId,
      );
    },

    // ── Tool Calls ──

    async saveToolCall(record) {
      toolCalls.push(record);
    },

    async listToolCalls(sessionId, turnId?) {
      return toolCalls.filter(
        (r) => r.sessionId === sessionId && (turnId === undefined || r.turnId === turnId),
      );
    },

    // ── State Schemas ──

    async saveStateSchema(record) {
      stateSchemas.push(record);
    },

    async listStateSchemas(sessionId) {
      return stateSchemas.filter((r) => r.sessionId === sessionId);
    },

    async deleteStateSchema(sessionId, tableName) {
      const idx = stateSchemas.findIndex(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
      if (idx !== -1) stateSchemas.splice(idx, 1);
    },

    // ── State Entries ──

    async getStateEntry(sessionId, tableName, fieldName) {
      return stateEntries.get(stateEntryKey(sessionId, tableName, fieldName)) ?? null;
    },

    async upsertStateEntry(record) {
      stateEntries.set(
        stateEntryKey(record.sessionId, record.tableName, record.fieldName),
        record,
      );
    },

    async listStateEntries(sessionId, tableName) {
      return [...stateEntries.values()].filter(
        (r) => r.sessionId === sessionId && r.tableName === tableName,
      );
    },

    // ── State Changes ──

    async addStateChange(record) {
      stateChanges.push(record);
    },

    async listStateChanges(sessionId, tableName, fieldName) {
      return stateChanges
        .filter(
          (r) =>
            r.sessionId === sessionId &&
            r.tableName === tableName &&
            r.fieldName === fieldName,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    // ── Events ──

    async saveEvent(record) {
      events.push(record);
    },

    async listEvents(sessionId, options?) {
      let filtered = events.filter((r) => r.sessionId === sessionId);
      if (options?.topic !== undefined) {
        filtered = filtered.filter((r) => r.topic === options.topic);
      }
      if (options?.limit !== undefined) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },

    // ── Approvals ──

    async saveApproval(record) {
      approvals.push(record);
    },

    async listApprovals(sessionId) {
      return approvals.filter((r) => r.sessionId === sessionId);
    },

    // ── Messages ──

    async addMessage(record) {
      messages.push(record);
    },

    async listMessages(sessionId, pagination?) {
      const filtered = messages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    // ── Characters ──

    async upsertCharacter(record) {
      characters.set(record.id, record);
    },

    async listCharacters(sessionId) {
      return [...characters.values()].filter((r) => r.sessionId === sessionId);
    },

    // ── Plugin Data ──

    async setPluginData(record) {
      pluginData.set(pluginDataKey(record.sessionId, record.pluginId, record.namespace, record.key), record);
    },

    async setPluginDataBatch(records) {
      for (const record of records) {
        pluginData.set(pluginDataKey(record.sessionId, record.pluginId, record.namespace, record.key), record);
      }
    },

    async getPluginData(sessionId, pluginId, namespace, key) {
      return pluginData.get(pluginDataKey(sessionId, pluginId, namespace, key)) ?? null;
    },

    async listPluginData(sessionId, pluginId, namespace?, pagination?) {
      const filtered = [...pluginData.values()].filter(
        (r) =>
          r.sessionId === sessionId &&
          r.pluginId === pluginId &&
          (namespace === undefined || r.namespace === namespace),
      );
      return applyPagination(filtered, pagination);
    },

    async deletePluginData(sessionId, pluginId, namespace, key) {
      pluginData.delete(pluginDataKey(sessionId, pluginId, namespace, key));
    },

    // ── Plugin Configs ──

    async savePluginConfig(record) {
      pluginConfigs.set(pluginConfigKey(record.sessionId, record.pluginId), record);
    },

    async getPluginConfig(sessionId, pluginId) {
      return pluginConfigs.get(pluginConfigKey(sessionId, pluginId)) ?? null;
    },

    // ── Worlds ──

    async listWorlds() {
      return [...worlds.values()];
    },

    async getWorld(id) {
      return worlds.get(id) ?? null;
    },

    async upsertWorld(record) {
      worlds.set(record.id, record);
    },

    // ── Trace ──

    async addTraceEvent(record) {
      traceEvents.push(record);
    },

    async listTraceEvents(sessionId, pagination?) {
      const filtered = traceEvents.filter((r) => r.sessionId === sessionId);
      return applyPagination(filtered, pagination);
    },

    // ── Turn Messages ──

    async appendTurnMessage(record) {
      turnMessages.push(record);
    },

    async listTurnMessages(sessionId, pagination?) {
      const filtered = turnMessages
        .filter((r) => r.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return applyPagination(filtered, pagination);
    },

    // ── Player Inputs ──

    async savePlayerInput(record) {
      playerInputs.push(record);
    },

    async getPlayerInput(sessionId, formId) {
      return playerInputs.find(
        (r) => r.sessionId === sessionId && r.formId === formId,
      ) ?? null;
    },

    async listPlayerInputs(sessionId) {
      return playerInputs.filter((r) => r.sessionId === sessionId);
    },

    // ── Working Memory (S3-T3) ───────────────────────────────

    async upsertWorkingMemory(record: WorkingMemoryRecord): Promise<void> {
      const k = workingMemoryKey(record.sessionId, record.scope, record.key);
      workingMemoryEntries.set(k, record);
    },

    async getWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<WorkingMemoryRecord | null> {
      const k = workingMemoryKey(sessionId, scope, key);
      return workingMemoryEntries.get(k) ?? null;
    },

    async listWorkingMemory(sessionId: string): Promise<readonly WorkingMemoryRecord[]> {
      const entries = Array.from(workingMemoryEntries.values()).filter(
        (r) => r.sessionId === sessionId,
      );
      // Sort: scope order player → story → shared, then alphabetical key
      const scopeOrder: Record<string, number> = { player: 0, story: 1, shared: 2 };
      entries.sort((a, b) => {
        const scopeDiff = (scopeOrder[a.scope] ?? 99) - (scopeOrder[b.scope] ?? 99);
        if (scopeDiff !== 0) return scopeDiff;
        return a.key.localeCompare(b.key);
      });
      return entries;
    },

    async deleteWorkingMemory(
      sessionId: string,
      scope: WorkingMemoryRecord['scope'],
      key: string,
    ): Promise<void> {
      const k = workingMemoryKey(sessionId, scope, key);
      workingMemoryEntries.delete(k);
    },

    // ── Session Summaries (S2-T2 Compactor) ──

    async saveSessionSummary(record: SessionSummaryRecord): Promise<void> {
      sessionSummaries.push(record);
    },

    async listSessionSummaries(sessionId: string): Promise<readonly SessionSummaryRecord[]> {
      return sessionSummaries.filter((r) => r.sessionId === sessionId);
    },

    async deleteSessionSummaries(sessionId: string): Promise<void> {
      for (let i = sessionSummaries.length - 1; i >= 0; i--) {
        if (sessionSummaries[i]!.sessionId === sessionId) {
          sessionSummaries.splice(i, 1);
        }
      }
    },

    async tagTurnMessagesCompacted(
      sessionId: string,
      messageIds: readonly string[],
      summaryId: string,
    ): Promise<void> {
      const idSet = new Set(messageIds);
      for (let i = 0; i < turnMessages.length; i++) {
        const msg = turnMessages[i]!;
        if (msg.sessionId === sessionId && idSet.has(msg.id)) {
          turnMessages[i] = { ...msg, compactedAtTurnId: summaryId };
        }
      }
    },

    // ── Suspensions (S4-T4) ──

    async saveSuspension(record) {
      suspensions.set(record.id, record);
    },

    async getSuspension(id) {
      return suspensions.get(id) ?? null;
    },

    async markSuspensionResolved(id) {
      const existing = suspensions.get(id);
      if (!existing) return;
      suspensions.set(id, { ...existing, resolvedAt: new Date().toISOString() });
    },

    async listSuspensions(sessionId) {
      return [...suspensions.values()].filter((r) => r.sessionId === sessionId);
    },

    async deleteSuspension(id) {
      suspensions.delete(id);
    },

    // ── Vector Store (brute-force, O(n) — fine for tests and <1k rows) ──

    async upsertVector(input: UpsertVectorInput) {
      if (input.embedding.length !== input.dimensions) {
        throw new Error(
          `Memory vector upsert: embedding length ${input.embedding.length} does not match declared dimensions ${input.dimensions}`,
        );
      }
      const rowKey = vectorRowKey(
        input.sessionId,
        input.pluginId,
        input.namespace,
        input.key,
        input.dimensions,
      );
      // Copy the Float32Array to decouple from caller-owned buffers.
      vectorRows.set(rowKey, {
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        namespace: input.namespace,
        key: input.key,
        dimensions: input.dimensions,
        embedding: new Float32Array(input.embedding),
        payload: input.payload ?? null,
      });
    },

    async searchVectors(input: SearchVectorsInput): Promise<VectorSearchResult[]> {
      if (input.query.length !== input.dimensions) {
        throw new Error(
          `Memory vector search: query length ${input.query.length} does not match declared dimensions ${input.dimensions}`,
        );
      }
      const scored: Array<{ row: MemoryVectorRow; distance: number }> = [];
      for (const row of vectorRows.values()) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.dimensions !== input.dimensions) continue;
        if (input.pluginId !== undefined && row.pluginId !== input.pluginId) continue;
        if (input.namespace !== undefined && row.namespace !== input.namespace) continue;
        scored.push({ row, distance: squaredL2(input.query, row.embedding) });
      }
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, Math.max(0, input.topK)).map(({ row, distance }) => ({
        sessionId: row.sessionId,
        pluginId: row.pluginId,
        namespace: row.namespace,
        key: row.key,
        distance,
        payload: row.payload,
      }));
    },

    async deleteVectors(input: DeleteVectorsInput) {
      for (const [rowKey, row] of Array.from(vectorRows.entries())) {
        if (row.sessionId !== input.sessionId) continue;
        if (row.pluginId !== input.pluginId) continue;
        if (input.namespace !== undefined && row.namespace !== input.namespace) continue;
        if (input.dimensions !== undefined && row.dimensions !== input.dimensions) continue;
        vectorRows.delete(rowKey);
      }
    },

    // ── Transactions (S4-T1) ──

    async beginTx() {
      if (snapshot !== null) {
        throw new Error('MemoryStore: nested transactions are not supported (beginTx called while another tx is active)');
      }
      snapshot = captureSnapshot();
    },

    async commitTx() {
      if (snapshot === null) {
        throw new Error('MemoryStore: commitTx called without an active transaction');
      }
      snapshot = null;
    },

    async rollbackTx() {
      if (snapshot === null) {
        throw new Error('MemoryStore: rollbackTx called without an active transaction');
      }
      restoreSnapshot(snapshot);
      snapshot = null;
    },

    // ── Lifecycle ──

    async close() {
      // No-op for in-memory store
    },
  };

  return store;
}
