/**
 * Per-file isolated Postgres database for contract tests.
 *
 * Multiple PG-backed test files (pg-store, media-store, …) run concurrently in separate
 * vitest workers, and each does a `freshSchema` DROP+CREATE. Sharing one database makes
 * them race on schema DDL — concurrent `CREATE TABLE` collide on `pg_type_typname_nsp_index`
 * — and clobber each other's rows mid-test. Giving each file its own database removes the
 * race entirely.
 *
 * Falls back to the shared base URL when the connecting role cannot CREATE DATABASE (e.g.
 * a locked-down CI role), so restricted environments behave exactly as before instead of
 * failing outright.
 */
import { randomUUID } from "node:crypto";

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
    console.warn(
      `[pg-test-db] could not create isolated database "${dbName}" ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to the shared database — PG tests may be flaky under parallel runs.`,
    );
    return { url: baseUrl, cleanup: async () => undefined };
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return {
    url: url.toString(),
    cleanup: async () => {
      const cleanupAdmin = postgres(baseUrl, { max: 1, connect_timeout: 5 });
      try {
        await cleanupAdmin.unsafe(
          `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
        );
      } finally {
        await cleanupAdmin.end();
      }
    },
  };
}
