/**
 * Per-file isolated Postgres database for contract tests.
 *
 * Multiple PG-backed test files (pg-store, media-store, …) run concurrently in separate
 * vitest workers, and each does a `freshSchema` DROP+CREATE. Sharing one database makes
 * them race on schema DDL — concurrent `CREATE TABLE` collide on `pg_type_typname_nsp_index`
 * — and clobber each other's rows mid-test. Giving each file its own database removes the
 * race entirely.
 *
 * Isolation is fail-closed: falling back to the shared base database would let a
 * subsequent `freshSchema` destroy another worker's schema.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * DROP DATABASE can transiently fail under parallel workers: a sibling test
 * still holding a connection, or a catalog lock from a concurrent
 * CREATE/DROP, surfaces as `55006 database is being accessed by other users`
 * (FORCE only terminates connections that already finished their query) or a
 * lock_timeout. These clear within a few hundred ms, so retry with backoff
 * instead of failing the hook on a timing race. The database name is unique
 * per file, so retries only ever target this file's own database.
 */
const CLEANUP_ATTEMPTS = 5;
const CLEANUP_BACKOFF_MS = [250, 500, 1000, 2000];

async function dropDatabaseWithRetry(
  postgres: (
    url: string,
    opts?: { max?: number; connect_timeout?: number },
  ) => Sql,
  baseUrl: string,
  dbName: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    const cleanupAdmin = postgres(baseUrl, { max: 1, connect_timeout: 5 });
    try {
      await cleanupAdmin.unsafe(
        `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
      );
      return;
    } catch (err) {
      lastError = err;
      if (attempt < CLEANUP_ATTEMPTS - 1) {
        await sleep(CLEANUP_BACKOFF_MS[attempt]!);
      }
    } finally {
      await cleanupAdmin.end().catch(() => {});
    }
  }
  throw lastError;
}

export async function createIsolatedPgDatabase(
  baseUrl: string,
  dbNamePrefix: string,
): Promise<IsolatedPgDatabase> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(baseUrl, { max: 1, connect_timeout: 5 });
  const dbName = uniqueDatabaseName(dbNamePrefix);
  try {
    // The identifier is generated entirely from a test-controlled prefix plus a
    // process/UUID suffix, so parallel Vitest processes never target each
    // other's database.
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    throw new Error(
      `[pg-test-db] could not create isolated database "${dbName}"; refusing to run destructive schema tests against the shared database`,
      { cause: err },
    );
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return {
    url: url.toString(),
    cleanup: () => dropDatabaseWithRetry(postgres, baseUrl, dbName),
  };
}
