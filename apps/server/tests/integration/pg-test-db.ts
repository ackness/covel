/**
 * Per-process PostgreSQL database isolation for server integration tests.
 *
 * Test files may be launched by separate Vitest or Codex processes. A fixed
 * database name plus DROP ... WITH (FORCE) lets one process destroy another
 * process's schema, so every caller owns a unique database and only drops that
 * exact database during cleanup.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";

export interface IsolatedPgDatabase {
  readonly url: string;
  readonly cleanup: () => Promise<void>;
}

const PG_IDENTIFIER_MAX_LENGTH = 63;

function uniqueDatabaseName(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_]/g, "_");
  const suffix = `${process.pid}_${randomUUID().slice(0, 8)}`;
  const maxPrefixLength = PG_IDENTIFIER_MAX_LENGTH - suffix.length - 1;
  return `${normalized.slice(0, maxPrefixLength)}_${suffix}`;
}

export async function createIsolatedPgDatabase(
  baseUrl: string,
  prefix: string,
): Promise<IsolatedPgDatabase> {
  const databaseName = uniqueDatabaseName(prefix);
  const admin = postgres(baseUrl, { max: 1, connect_timeout: 3 });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    throw new Error(
      `[server-pg-test] could not create isolated database "${databaseName}"; refusing to use the shared database`,
      { cause: error },
    );
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;

  return {
    url: url.toString(),
    cleanup: async () => {
      const cleanupAdmin = postgres(baseUrl, {
        max: 1,
        connect_timeout: 3,
      });
      try {
        await cleanupAdmin.unsafe(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      } finally {
        await cleanupAdmin.end();
      }
    },
  };
}
