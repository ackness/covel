import type { DataStore } from "../types.js";
import type { SqliteConnection } from "./sqlite-types.js";

export type SqliteTransactions = Pick<
  DataStore,
  "beginTx" | "commitTx" | "rollbackTx"
>;

export function createSqliteTransactions(
  sqlite: SqliteConnection,
): SqliteTransactions {
  let txActive = false;

  return {
    async beginTx(): Promise<void> {
      if (txActive) {
        throw new Error(
          "SqliteStore: nested transactions are not supported (beginTx called while another tx is active)",
        );
      }
      sqlite.exec("BEGIN");
      txActive = true;
    },

    async commitTx(): Promise<void> {
      if (!txActive) {
        throw new Error(
          "SqliteStore: commitTx called without an active transaction",
        );
      }
      // Reset the flag in finally so a throwing COMMIT still clears state; the
      // next beginTx can recover instead of reporting a phantom active tx.
      try {
        sqlite.exec("COMMIT");
      } finally {
        txActive = false;
      }
    },

    async rollbackTx(): Promise<void> {
      if (!txActive) {
        throw new Error(
          "SqliteStore: rollbackTx called without an active transaction",
        );
      }
      try {
        sqlite.exec("ROLLBACK");
      } finally {
        txActive = false;
      }
    },
  };
}
