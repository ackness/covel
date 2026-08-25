/**
 * Backend-agnostic session-content queries (events / messages /
 * characters), shared by the PostgreSQL and SQLite backends.
 *
 * Previously the event/approval/message/character methods inside
 * `postgres/pg-session-content-records.ts` and `sqlite/sqlite-session-records.ts`
 * were line-for-line mirrors differing only in the sync/async terminal and the
 * JSON serialization. Both differences are injected here — the {@link SqlRunner}
 * abstracts the terminal, the {@link JsonReader} the read gateway, and the
 * value builders ({@link InsertValueBuilders}) the write gateway — so this is
 * the single source of truth for the session-content surface.
 */

import { and, asc, eq } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import { cursorPageOrder, cursorPageWhere } from "./cursor.js";
import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import {
  toCharacterRecord,
  toEventRecord,
  toMessageRecord,
} from "./mappers.js";
import type {
  CharacterRow,
  EventRow,
  MessageRow,
} from "./mappers/state-mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type {
  CharacterRecord,
  CursorPageOpts,
  DataStore,
  EventRecord,
  MessageRecord,
  PaginationOpts,
} from "../types.js";

type EventsTable = Table & {
  id: Column;
  sessionId: Column;
  topic: Column;
  createdAt: Column;
};
type MessagesTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
};
type CharactersTable = Table & { id: Column; sessionId: Column };

export interface SqlSessionContentTables {
  readonly events: EventsTable;
  readonly messages: MessagesTable;
  readonly characters: CharactersTable;
}

export interface SqlSessionContentDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSessionContentTables;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    "eventInsert" | "messageInsert" | "characterInsert" | "characterUpdate"
  >;
}

export type SqlSessionContentRecords = Pick<
  DataStore,
  | "saveEvent"
  | "listEvents"
  | "getEventById"
  | "addMessage"
  | "listMessages"
  | "listMessagesPage"
  | "upsertCharacter"
  | "listCharacters"
  | "deleteCharacter"
>;

export function createSqlSessionContentRecords(
  deps: SqlSessionContentDeps,
): SqlSessionContentRecords {
  const { runner, tables, json, values } = deps;
  const { events, messages, characters } = tables;

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

    async getEventById(
      sessionId: string,
      id: string,
    ): Promise<EventRecord | null> {
      const rows = await runner.select<EventRow>(events, {
        where: and(eq(events.id, id), eq(events.sessionId, sessionId)),
        limit: 1,
      });
      const row = rows[0];
      return row ? toEventRecord(row, json) : null;
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
        // `id` breaks same-millisecond ties so offset pagination cannot swap
        // rows between pages (media GC pages through this).
        orderBy: [asc(messages.createdAt), asc(messages.id)],
        limit: pagination?.limit,
        offset: pagination?.offset,
      });
      return rows.map((row) => toMessageRecord(row, json));
    },

    async listMessagesPage(
      sessionId: string,
      opts: CursorPageOpts,
    ): Promise<MessageRecord[]> {
      if (opts.limit <= 0) return [];
      const rows = await runner.select<MessageRow>(messages, {
        where: cursorPageWhere(messages, sessionId, opts.before),
        orderBy: cursorPageOrder(messages),
        limit: opts.limit,
      });
      return rows.reverse().map((row) => toMessageRecord(row, json));
    },

    async upsertCharacter(record: CharacterRecord): Promise<void> {
      await runner.insert(characters, values.characterInsert(record), {
        target: [characters.sessionId, characters.id],
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
