import { beforeEach, describe, expect, it } from "vitest";
import type { CharacterSchemaRecord } from "@covel/shared";
import type {
  DataStore,
  PluginDataRecord,
  SuspensionWriteTarget,
} from "../../types.js";
import { readSuspensionWriteDigest } from "../../common/suspension-write-digest.js";
import {
  makeCharacter,
  makeLorebookEntry,
  makeSession,
  makeStateEntry,
  ts,
} from "../test-fixtures.js";

/**
 * The digests a suspension compares to see whether a record it will write
 * changed after it was taken (`common/suspension-write-digest.ts`). Every
 * backend must give one digest for one content, whatever order it stores
 * object keys in, so a resume is refused on all of them for the same change.
 */
export function registerSuspensionWriteSuites(getStore: () => DataStore): void {
  let store: DataStore;

  beforeEach(() => {
    store = getStore();
  });

  const sessions = ["sess-baseline-a", "sess-baseline-b"] as const;
  const createSessions = async () => {
    for (const id of sessions) await store.createSession(makeSession({ id }));
  };
  const digest = (sessionId: string, target: SuspensionWriteTarget) =>
    readSuspensionWriteDigest(store, sessionId, target);
  const pluginRow = (
    sessionId: string,
    value: unknown,
    at: string,
  ): PluginDataRecord => ({
    id: `${sessionId}:stage`,
    sessionId,
    pluginId: "plugin-1",
    namespace: "quest",
    key: "stage",
    value,
    createdAt: at,
    updatedAt: at,
  });
  const pluginTarget: SuspensionWriteTarget = {
    kind: "plugin-data",
    pluginId: "plugin-1",
    namespace: "quest",
    key: "stage",
  };

  describe("suspension write digests", () => {
    it("gives one digest per plugin data content, whatever its key order, session or time", async () => {
      await createSessions();
      const [a, b] = sessions;
      expect(await digest(a, pluginTarget)).toBeNull();

      await store.setPluginData(
        pluginRow(a, { b: 1, a: { d: [1, { y: 2, x: 1 }], c: "é" } }, ts()),
      );
      const first = await digest(a, pluginTarget);
      expect(first).toMatch(/^[0-9a-f]{64}$/);

      // The same content in another key order, in another session (a fork).
      await store.setPluginData(
        pluginRow(b, { a: { c: "é", d: [1, { x: 1, y: 2 }] }, b: 1 }, ts(5)),
      );
      expect(await digest(b, pluginTarget)).toBe(first);

      // Rewriting the same content changes nothing; another value does.
      await store.setPluginData(
        pluginRow(a, { b: 1, a: { d: [1, { y: 2, x: 1 }], c: "é" } }, ts(9)),
      );
      expect(await digest(a, pluginTarget)).toBe(first);
      await store.setPluginData(
        pluginRow(a, { b: 2, a: { d: [1, { y: 2, x: 1 }], c: "é" } }, ts(10)),
      );
      expect(await digest(a, pluginTarget)).not.toBe(first);

      await store.deletePluginData(a, "plugin-1", "quest", "stage");
      expect(await digest(a, pluginTarget)).toBeNull();
    });

    it("tells state fields, characters, the character schema and lorebook entries apart by content", async () => {
      await createSessions();
      const [a, b] = sessions;
      const stateTarget: SuspensionWriteTarget = {
        kind: "state",
        table: "stats",
        field: "hp",
      };
      const characterTarget: SuspensionWriteTarget = {
        kind: "character",
        id: "char-1",
      };
      const schemaTarget: SuspensionWriteTarget = { kind: "character-schema" };
      const loreTarget: SuspensionWriteTarget = {
        kind: "lorebook",
        pluginId: "plugin-1",
        id: "lore-1",
      };
      const schema = (
        sessionId: string,
        at: string,
        types: readonly string[],
      ): CharacterSchemaRecord => ({
        sessionId,
        version: 1,
        types,
        attributes: [],
        createdAt: at,
        updatedAt: at,
      });
      const write = async (sessionId: string, at: string, hp: number) => {
        await store.upsertStateEntry(
          makeStateEntry({ sessionId, value: { hp }, updatedAt: at }),
        );
        await store.upsertCharacter(
          makeCharacter({
            id: "char-1",
            sessionId,
            fields: { hp },
            createdAt: at,
            updatedAt: at,
          }),
        );
        await store.upsertCharacterSchema(
          schema(sessionId, at, hp > 10 ? ["enemy", "ally"] : ["enemy"]),
        );
        await store.upsertLorebookEntries([
          makeLorebookEntry({
            id: "lore-1",
            sessionId,
            content: `hp ${hp}`,
            createdAt: at,
            updatedAt: at,
          }),
        ]);
      };
      const targets = [stateTarget, characterTarget, schemaTarget, loreTarget];
      const digests = (sessionId: string) =>
        Promise.all(targets.map((target) => digest(sessionId, target)));

      expect(await digests(a)).toEqual([null, null, null, null]);
      await write(a, ts(), 10);
      const first = await digests(a);
      for (const value of first) expect(value).toMatch(/^[0-9a-f]{64}$/);

      // Same content written later, and in another session: same digests.
      await write(b, ts(3), 10);
      expect(await digests(b)).toEqual(first);
      await write(a, ts(4), 10);
      expect(await digests(a)).toEqual(first);

      // Changed content: every digest changes.
      await write(a, ts(5), 11);
      const changed = await digests(a);
      for (const [index, value] of changed.entries()) {
        expect(value).not.toBe(first[index]);
      }
    });

    it("reads what its own transaction wrote", async () => {
      await createSessions();
      const [a] = sessions;
      const inTx = await store.withTransaction(async (tx) => {
        await tx.setPluginData(pluginRow(a, { step: 2 }, ts()));
        return readSuspensionWriteDigest(tx, a, pluginTarget);
      });
      expect(inTx).not.toBeNull();
      expect(await digest(a, pluginTarget)).toBe(inTx);
    });
  });
}
