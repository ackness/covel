/**
 * Plugin-data DataStore contract extras — runs against MemoryStore + SqliteStore.
 *
 * Pins the plugin-data write/read invariants the kernel depends on:
 *  - JSONB null vs missing: storing `value: null` is preserved as null on read
 *  - Namespace isolation: `(sessionId, pluginId, namespace, key)` is the key
 *  - Last-write-wins per (pluginId, namespace, key)
 *  - `setPluginDataBatch` is atomic from the kernel's perspective: list reads
 *    after a batch see all entries, never a mid-batch state.
 *  - Multi-runtime plugins share the pluginId (so writes from `codex/unlocker`
 *    are visible to a list scoped to `pluginId='codex'`)
 *
 * The PG backend is exercised by the existing `pg-store.test.ts` contract
 * runner; we don't duplicate the connect-or-skip dance here.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { DataStore, PluginDataRecord } from '../src/types.js';
import { createMemoryStore } from '../src/memory/memory-store.js';
import { createSqliteStore } from '../src/sqlite/sqlite-store.js';

const SESSION = 'sess-pd';

function row(overrides: Partial<PluginDataRecord>): PluginDataRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: SESSION,
    pluginId: 'codex',
    namespace: 'entries',
    key: 'k1',
    value: { title: 'demo' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const backends: ReadonlyArray<{ name: string; create: () => DataStore | Promise<DataStore> }> = [
  { name: 'MemoryStore', create: () => createMemoryStore() },
  {
    name: 'SqliteStore',
    create: () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'covel-pd-extras-'));
      return createSqliteStore(path.join(tmpDir, 'test.db'));
    },
  },
];

for (const { name, create } of backends) {
  describe(`plugin-data extras — ${name}`, () => {
    // Known regression on SqliteStore (2026-04-28): the mapper at
    // sqlite-store.ts setPluginData uses `record.value != null ? toJson(record.value) : null`
    // which writes SQL NULL for a JSON null payload. On read, `fromJson(null)`
    // returns `undefined`, so a null round-trips as undefined. MemoryStore
    // keeps the null. We pin both behaviours so a future fix in SQLite flips
    // the `.fails` annotation, prompting the matching PR to flip it back to a
    // plain `it` and adopt the cross-backend invariant.
    const nullTest = name === 'SqliteStore' ? it.fails : it;
    nullTest(
      'preserves a null value on round-trip (JSONB null is not collapsed to undefined)',
      async () => {
        const store = await create();
        await store.setPluginData(row({ value: null }));
        const fetched = await store.getPluginData(SESSION, 'codex', 'entries', 'k1');
        expect(fetched).toBeDefined();
        expect(fetched!.value).toBeNull();
      },
    );

    it('isolates namespaces: list("a") does not return entries written to namespace "b"', async () => {
      const store = await create();
      await store.setPluginData(row({ namespace: 'a', key: 'shared', value: 'A' }));
      await store.setPluginData(row({ namespace: 'b', key: 'shared', value: 'B' }));

      const fromA = await store.listPluginData(SESSION, 'codex', 'a');
      const fromB = await store.listPluginData(SESSION, 'codex', 'b');

      expect(fromA).toHaveLength(1);
      expect(fromA[0].value).toBe('A');
      expect(fromB).toHaveLength(1);
      expect(fromB[0].value).toBe('B');
    });

    it('isolates pluginId: codex writes do not leak into world-init reads', async () => {
      const store = await create();
      await store.setPluginData(row({ pluginId: 'codex', value: 'codex-val' }));
      await store.setPluginData(row({ pluginId: 'world-init', value: 'wi-val' }));

      const codex = await store.getPluginData(SESSION, 'codex', 'entries', 'k1');
      const wi = await store.getPluginData(SESSION, 'world-init', 'entries', 'k1');

      expect(codex?.value).toBe('codex-val');
      expect(wi?.value).toBe('wi-val');
    });

    it('isolates sessionId: writes in one session are invisible to another', async () => {
      const store = await create();
      await store.setPluginData(row({ sessionId: 'sess-A' }));
      await store.setPluginData(row({ sessionId: 'sess-B', value: 'B' }));

      const a = await store.listPluginData('sess-A', 'codex', 'entries');
      const b = await store.listPluginData('sess-B', 'codex', 'entries');
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0].value).not.toEqual(b[0].value);
    });

    it('last write wins for the same (sessionId, pluginId, namespace, key)', async () => {
      const store = await create();
      await store.setPluginData(row({ value: 'first' }));
      await store.setPluginData(row({ value: 'second' }));

      const fetched = await store.getPluginData(SESSION, 'codex', 'entries', 'k1');
      expect(fetched?.value).toBe('second');

      // List should report exactly ONE row, not two.
      const list = await store.listPluginData(SESSION, 'codex', 'entries');
      expect(list).toHaveLength(1);
    });

    it('setPluginDataBatch — all entries become visible together', async () => {
      const store = await create();
      const items = Array.from({ length: 5 }, (_, i) =>
        row({ key: `batch-${i}`, value: { i } }),
      );
      await store.setPluginDataBatch(items);

      const list = await store.listPluginData(SESSION, 'codex', 'entries');
      expect(list).toHaveLength(5);
      const keys = list.map((r) => r.key).sort();
      expect(keys).toEqual(['batch-0', 'batch-1', 'batch-2', 'batch-3', 'batch-4']);
    });

    it('setPluginDataBatch — empty array is a no-op', async () => {
      const store = await create();
      // Some backends (e.g. better-sqlite3) reject "INSERT INTO ... VALUES"
      // statements with zero values. The contract is: empty batch must not
      // throw and must not produce phantom rows.
      await expect(store.setPluginDataBatch([])).resolves.not.toThrow();
      const list = await store.listPluginData(SESSION, 'codex', 'entries');
      expect(list).toHaveLength(0);
    });

    it('list filters by namespace — sibling namespaces under the same plugin are excluded', async () => {
      const store = await create();
      await store.setPluginData(row({ namespace: 'images', key: 'img-1', value: { ref: 'a' } }));
      await store.setPluginData(row({ namespace: '_jobs', key: 'job-1', value: { status: 'done' } }));
      await store.setPluginData(row({ namespace: 'images', key: 'img-2', value: { ref: 'b' } }));

      const images = await store.listPluginData(SESSION, 'codex', 'images');
      const jobs = await store.listPluginData(SESSION, 'codex', '_jobs');

      expect(images.map((r) => r.key).sort()).toEqual(['img-1', 'img-2']);
      expect(jobs.map((r) => r.key)).toEqual(['job-1']);
    });

    it('handles deeply nested object values without flattening keys', async () => {
      // Frontends rely on round-trip JSON without object key flattening
      // (a regression here would corrupt UI specs and lorebook entries).
      const value = {
        meta: {
          tags: ['a', 'b'],
          nested: { deeper: { count: 3 } },
        },
        list: [1, 2, 3],
      };
      const store = await create();
      await store.setPluginData(row({ value }));
      const fetched = await store.getPluginData(SESSION, 'codex', 'entries', 'k1');
      expect(fetched?.value).toEqual(value);
    });
  });
}
