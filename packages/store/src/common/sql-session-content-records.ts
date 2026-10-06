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

import { and, asc, eq, isNull } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";

import { cursorPageOrder, cursorPageWhere } from "./cursor.js";
import {
  adoptPlayerInputMessage,
  assertCommittedPlayerInput,
} from "./player-input-message.js";
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
  CharacterSchemaRecord,
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
  role: Column;
  content: Column;
  metadata: Column;
  createdAt: Column;
};
type CharactersTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
};

export interface SqlSessionContentTables {
  readonly events: EventsTable;
  readonly messages: MessagesTable;
  readonly characters: CharactersTable;
  readonly characterSchemas: Table & { sessionId: Column };
}

export interface SqlSessionContentDeps {
  readonly runner: SqlRunner;
  readonly tables: SqlSessionContentTables;
  /** A text column compared byte by byte; see `SqlDataCrudDeps.byteOrder`. */
  readonly byteOrder?: (column: Column) => Column | SQL;
  readonly json: JsonReader;
  readonly values: Pick<
    InsertValueBuilders,
    | "eventInsert"
    | "messageInsert"
    | "characterInsert"
    | "characterUpdate"
    | "characterSchemaInsert"
  >;
}

export type SqlSessionContentRecords = Pick<
  DataStore,
  | "saveEvent"
  | "listEvents"
  | "getEventById"
  | "addMessage"
  | "commitPlayerInputMessage"
  | "listMessages"
  | "listMessagesPage"
  | "getCharacterSchema"
  | "upsertCharacterSchema"
  | "upsertCharacter"
  | "listCharacters"
  | "deleteCharacter"
>;

export function createSqlSessionContentRecords(
  deps: SqlSessionContentDeps,
): SqlSessionContentRecords {
  const { runner, tables, json, values } = deps;
  const { events, messages, characters, characterSchemas } = tables;
  const byteOrder = deps.byteOrder ?? ((column: Column) => column);

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

    async commitPlayerInputMessage(record: MessageRecord): Promise<void> {
      assertCommittedPlayerInput(record);
      if (
        await runner.insertIgnoreReturningCount(
          messages,
          values.messageInsert(record),
          messages.id,
        )
      )
        return;
      const row = await runner.selectFirst<MessageRow>(messages, {
        where: eq(messages.id, record.id),
      });
      if (!row) throw new Error("Player input disappeared before commit");
      const adopted = adoptPlayerInputMessage(
        toMessageRecord(row, json),
        record,
      );
      const count = await runner.updateReturningCount(
        messages,
        { metadata: values.messageInsert(adopted).metadata },
        and(
          eq(messages.id, record.id),
          eq(messages.sessionId, row.sessionId),
          eq(messages.role, row.role),
          eq(messages.content, row.content),
          eq(messages.createdAt, row.createdAt),
          row.metadata == null
            ? isNull(messages.metadata)
            : eq(messages.metadata, row.metadata),
        ),
      );
      // Compare-and-swap protects callers even outside a session lock.
      if (count !== 1) {
        const current = await runner.selectFirst<MessageRow>(messages, {
          where: eq(messages.id, record.id),
        });
        if (current) {
          const existing = toMessageRecord(current, json);
          // Another identical same-turn commit may have won the CAS.
          if (adoptPlayerInputMessage(existing, record) === existing) return;
        }
        throw new Error("Player input changed before commit");
      }
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

    async getCharacterSchema(
      sessionId: string,
    ): Promise<CharacterSchemaRecord | null> {
      const rows = await runner.select<
        Omit<CharacterSchemaRecord, "types" | "attributes"> & {
          types: unknown;
          attributes: unknown;
        }
      >(characterSchemas, {
        where: eq(characterSchemas.sessionId, sessionId),
        limit: 1,
      });
      const row = rows[0];
      return row
        ? {
            ...row,
            types: json.readRequired(
              row.types,
            ) as CharacterSchemaRecord["types"],
            attributes: json.readRequired(
              row.attributes,
            ) as CharacterSchemaRecord["attributes"],
          }
        : null;
    },

    async upsertCharacterSchema(record: CharacterSchemaRecord): Promise<void> {
      const value = values.characterSchemaInsert(record);
      await runner.insert(characterSchemas, value, {
        target: [characterSchemas.sessionId],
        set: value,
      });
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
        // Without an order PostgreSQL returns rows as they lie on disk, and
        // an updated row moves: the roster a prompt shows changed order
        // after a character changed.
        orderBy: [asc(characters.createdAt), asc(byteOrder(characters.id))],
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
