/**
 * Startup schema-version behaviour, shared by the SQLite and PostgreSQL tests
 * so both backends accept and refuse the same databases.
 */
import { describe, expect, it } from "vitest";

import { StoreSchemaVersionError } from "../src/errors.js";
import { DATA_SCHEMA_VERSION } from "../src/migrations.js";

export interface SchemaVersionHarness {
  /** Empty the database: no Covel tables and no recorded version. */
  reset(): Promise<void>;
  /** Open a store on the database the way the server does. */
  open(): Promise<{ close(): Promise<void> }>;
  /** The recorded version, or null when none is recorded. */
  recordedVersion(): Promise<number | null>;
  /** Record a version, or remove the record with null. */
  setRecordedVersion(version: number | null): Promise<void>;
  /** Replace `worlds` with a table that has only an `id` column. */
  replaceWorldsWithOldTable(): Promise<void>;
  /** The columns `worlds` has now. */
  worldsColumns(): Promise<string[]>;
}

async function openAndClose(harness: SchemaVersionHarness): Promise<void> {
  const store = await harness.open();
  await store.close();
}

async function refusal(
  harness: SchemaVersionHarness,
): Promise<StoreSchemaVersionError> {
  const error = await harness.open().then(
    async (store) => {
      await store.close();
      return undefined;
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StoreSchemaVersionError);
  return error as StoreSchemaVersionError;
}

export function runSchemaVersionTests(
  name: string,
  harness: () => SchemaVersionHarness,
): void {
  describe(`${name} schema version`, () => {
    it("records the current version in a new database", async () => {
      const h = harness();
      await h.reset();
      await openAndClose(h);
      expect(await h.recordedVersion()).toBe(DATA_SCHEMA_VERSION);
      await openAndClose(h);
      expect(await h.recordedVersion()).toBe(DATA_SCHEMA_VERSION);
    });

    it("refuses a database written by a newer build and leaves it alone", async () => {
      const h = harness();
      await h.reset();
      await openAndClose(h);
      await h.setRecordedVersion(DATA_SCHEMA_VERSION + 1);
      const error = await refusal(h);
      expect(error.code).toBe("store_schema_incompatible");
      expect(error.found).toBe(DATA_SCHEMA_VERSION + 1);
      expect(error.message).toMatch(/newer Covel/);
      expect(error.message).toMatch(/Back up/);
      expect(await h.recordedVersion()).toBe(DATA_SCHEMA_VERSION + 1);
    });

    it("refuses a database recorded with an older version", async () => {
      const h = harness();
      await h.reset();
      await openAndClose(h);
      await h.setRecordedVersion(DATA_SCHEMA_VERSION - 1);
      const error = await refusal(h);
      expect(error.found).toBe(DATA_SCHEMA_VERSION - 1);
      expect(error.message).toMatch(/older Covel/);
    });

    it("opens an unrecorded database whose tables have every column", async () => {
      const h = harness();
      await h.reset();
      await openAndClose(h);
      await h.setRecordedVersion(null);
      await openAndClose(h);
      expect(await h.recordedVersion()).toBe(DATA_SCHEMA_VERSION);
    });

    it("refuses an unrecorded database whose table lacks a column, before any DDL", async () => {
      const h = harness();
      await h.reset();
      await openAndClose(h);
      await h.setRecordedVersion(null);
      await h.replaceWorldsWithOldTable();
      const error = await refusal(h);
      expect(error.found).toBeNull();
      expect(error.missingColumns).toContain("worlds.name");
      expect(await h.recordedVersion()).toBeNull();
      expect(await h.worldsColumns()).toEqual(["id"]);
    });

    it("opens a new database from two stores started together", async () => {
      const h = harness();
      await h.reset();
      const stores = await Promise.all([h.open(), h.open()]);
      await Promise.all(stores.map((store) => store.close()));
      expect(await h.recordedVersion()).toBe(DATA_SCHEMA_VERSION);
    });
  });
}
