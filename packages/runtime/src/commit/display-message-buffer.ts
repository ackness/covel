import type { MessageRecord, StoreTransaction } from "@covel/store";

/**
 * A unit's display rows are inserted once, after its operations settle. Reads
 * through this view include staged rows; all other methods keep the original
 * transaction binding. This is internal to finalization, not a history editor.
 */
export function createDisplayMessageBuffer(tx: StoreTransaction) {
  const records: MessageRecord[] = [];
  const all = async (sink: StoreTransaction, sessionId: string) =>
    [
      ...(await sink.listMessages(sessionId)),
      ...records.filter((m) => m.sessionId === sessionId),
    ].sort((a, b) =>
      a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1,
    );
  const view = (sink: StoreTransaction): StoreTransaction => {
    const overrides: Partial<StoreTransaction> = {
      addMessage: async (record) => {
        if (
          records.some((row) => row.id === record.id) ||
          (await sink.getMessage(record.sessionId, record.id))
        )
          throw new Error(`Message already exists: ${record.id}`);
        records.push(structuredClone(record));
      },
      getMessage: async (sessionId, id) =>
        records.find((row) => row.id === id && row.sessionId === sessionId) ??
        sink.getMessage(sessionId, id),
      listMessages: async (sessionId, pagination) => {
        const rows = await all(sink, sessionId);
        const offset = pagination?.offset ?? 0;
        return rows.slice(
          offset,
          pagination?.limit === undefined
            ? undefined
            : offset + pagination.limit,
        );
      },
      listMessagesPage: async (sessionId, opts) => {
        if (opts.limit <= 0) return [];
        const rows = await all(sink, sessionId);
        const before = opts.before;
        const index = before
          ? rows.findIndex(
              (row) =>
                row.id === before.id && row.createdAt === before.createdAt,
            )
          : -1;
        return rows
          .filter(
            (row, i) =>
              !before ||
              row.createdAt < before.createdAt ||
              (row.createdAt === before.createdAt && index >= 0 && i < index),
          )
          .slice(-opts.limit);
      },
      listExistingMessageIds: async (sessionId, ids) => [
        ...new Set([
          ...(await sink.listExistingMessageIds(sessionId, ids)),
          ...records
            .filter(
              (row) => row.sessionId === sessionId && ids.includes(row.id),
            )
            .map((row) => row.id),
        ]),
      ],
      ...(sink.savepoint
        ? {
            savepoint: async <T>(
              body: (sp: StoreTransaction) => Promise<T>,
            ): Promise<T> => {
              const length = records.length;
              try {
                return await sink.savepoint!(async (sp) => body(view(sp)));
              } catch (error) {
                records.length = length;
                throw error;
              }
            },
          }
        : {}),
    };
    return new Proxy(sink, {
      get(target, property) {
        if (Object.hasOwn(overrides, property))
          return Reflect.get(overrides, property);
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return {
    store: view(tx),
    /** Flush in original insertion order; never mutate a previously stored row. */
    async flush(notice?: {
      readonly messageId: string;
      readonly count: number;
    }): Promise<void> {
      for (const record of records) {
        await tx.addMessage(
          record.id === notice?.messageId
            ? {
                ...record,
                metadata: {
                  ...(record.metadata as Record<string, unknown>),
                  operationFailures: { count: notice.count },
                },
              }
            : record,
        );
      }
      records.length = 0;
    },
  };
}
