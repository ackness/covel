/**
 * Backend-agnostic session-content queries (events / approvals / messages /
 * characters), shared by the PostgreSQL and SQLite backends.
 *
 * Previously the event/approval/message/character methods inside
 * `postgres/pg-session-content-records.ts` and `sqlite/sqlite-session-records.ts`
 * were line-for-line mirrors differing only in the sync/async terminal and the
 * JSON serialization. Both differences are injected here — the {@link SqlRunner}
 * abstracts the terminal, the {@link JsonReader} the read gateway, and the
 * value builders ({@link InsertValueBuilders}) the write gateway — so this is
 * the single source of truth for the session-content surface.
 *
 * Plugin-config methods stay in their own shared module
 * (`./sql-plugin-config-records.ts`) because SQLite keeps them in a separate
 * factory (`sqlite/sqlite-plugin-configs.ts`); the PG content adapter delegates
 * to both, the SQLite session adapter to this one only.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toApprovalRecord,
  toCharacterRecord,
  toEventRecord,
  toMessageRecord,
} from "./mappers.js";
import type {
  ApprovalRow,
  CharacterRow,
  EventRow,
  MessageRow,
} from "./mappers/state-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  ApprovalRecord,
  CharacterRecord,
  DataStore,
  EventRecord,
  MessageRecord,
  PaginationOpts,
} from "../types.js";

type EventsTable = Table & {
  sessionId: Column;
  topic: Column;
  createdAt: Column;
};
type ApprovalsTable = Table & { sessionId: Column };
type MessagesTable = Table & { sessionId: Column; createdAt: Column };
type CharactersTable = Table & { id: Column; sessionId: Column };

export interface SqlSessionContentTables {
  readonly events: EventsTable;
  readonly approvals: ApprovalsTable;
  readonly messages: MessagesTable;
  readonly characters: CharactersTable;
}

export interface SqlSessionContentDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSessionContentTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "eventInsert"
    | "approvalInsert"
    | "messageInsert"
    | "characterInsert"
    | "characterUpdate"
  >;
}

export type SqlSessionContentRecords = Pick<
  DataStore,
  | "saveEvent"
  | "listEvents"
  | "saveApproval"
  | "listApprovals"
  | "addMessage"
  | "listMessages"
  | "upsertCharacter"
  | "listCharacters"
  | "deleteCharacter"
>;

export function createSqlSessionContentRecords(
  deps: SqlSessionContentDeps,
): SqlSessionContentRecords {
  const { runner, tables, json, values } = deps;
  const { events, approvals, messages, characters } = tables;

  return {
    async saveEvent(record: EventRecord): Promise<void> {
      await runner.insert(events, values.eventInsert(record));
    },

    async listEvents(
      sessionId: string,
      options?: { topic?: string; limit?: number },
    ): Promise<EventRecord[]> {
      const conditions: SQL[] = [eq(events.sessionId, sessionId)];
      if (options?.topic) {
        conditions.push(eq(events.topic, options.topic));
      }
      const rows = await runner.select<EventRow>(events, {
        where: and(...conditions),
        orderBy: [asc(events.createdAt)],
        limit: options?.limit,
      });
      return rows.map((row) => toEventRecord(row, json));
    },

    async saveApproval(record: ApprovalRecord): Promise<void> {
      await runner.insert(approvals, values.approvalInsert(record));
    },

    async listApprovals(sessionId: string): Promise<ApprovalRecord[]> {
      const rows = await runner.select<ApprovalRow>(approvals, {
        where: eq(approvals.sessionId, sessionId),
      });
      return rows.map((row) => toApprovalRecord(row));
    },

    async addMessage(record: MessageRecord): Promise<void> {
      await runner.insert(messages, values.messageInsert(record));
    },

    async listMessages(
      sessionId: string,
      pagination?: PaginationOpts,
    ): Promise<MessageRecord[]> {
      const rows = await runner.select<MessageRow>(messages, {
        where: eq(messages.sessionId, sessionId),
        orderBy: [asc(messages.createdAt)],
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toMessageRecord(row, json));
    },

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await runner.insert(characters, values.characterInsert(record), {
        target: characters.id,
        set: values.characterUpdate(record),
      });
    },

    async listCharacters(sessionId: string): Promise<CharacterRecord[]> {
      const rows = await runner.select<CharacterRow>(characters, {
        where: eq(characters.sessionId, sessionId),
      });
      return rows.map((row) => toCharacterRecord(row, json));
    },

    async deleteCharacter(sessionId: string, id: string): Promise<void> {
      await runner.delete(
        characters,
        and(eq(characters.sessionId, sessionId), eq(characters.id, id)),
      );
    },
  };
}
