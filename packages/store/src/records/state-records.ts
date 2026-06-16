/**
 * State, event, approval, message and character record types.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

export interface StateSchemaRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly schema: unknown; // JSON — StateTableSchema
  readonly createdAt: string;
}

export interface StateEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly value: unknown; // JSON
  readonly updatedAt: string;
}

export interface StateChangeRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly value: unknown; // JSON
  readonly changedBy: string;
  readonly turnId: string;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface EventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly topic: string;
  readonly payload: unknown; // JSON
  readonly targetRuntime?: string;
  readonly turnId?: string;
  readonly createdAt: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly decision: string;
  readonly turnId: string;
  readonly createdAt: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly content: string;
  readonly metadata?: unknown; // JSON
  readonly createdAt: string;
}

export interface CharacterRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown; // JSON
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
