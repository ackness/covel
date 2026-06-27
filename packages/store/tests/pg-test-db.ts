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
export async function createIsolatedPgUrl(
  baseUrl: string,
  dbName: string,
): Promise<string> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(baseUrl, { max: 1, connect_timeout: 5 });
  try {
    // Identifier is a test-controlled constant, never user input — safe to inline.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    console.warn(
      `[pg-test-db] could not create isolated database "${dbName}" ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to the shared database — PG tests may be flaky under parallel runs.`,
    );
    return baseUrl;
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
