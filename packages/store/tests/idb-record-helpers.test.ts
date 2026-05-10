import { describe, expect, it } from "vitest";
import {
  makeInteractionRecord,
  makeRuntimeOutput,
  makeTurnMessage,
} from "../src/contract/test-fixtures.js";
import {
  filterInteractionRecords,
  filterRuntimeOutputs,
  paginateRows,
  putClonedRecord,
  sortByCreatedAtAsc,
} from "../src/indexeddb/idb-record-helpers.js";
import type { IdbMutationTracker } from "../src/indexeddb/idb-transaction.js";

describe("idb-record-helpers", () => {
  it("clones records before handing them to the mutation tracker", async () => {
    const stored: unknown[] = [];
    const mutations: IdbMutationTracker = {
      async ensureStoreSnapshot() {},
      async putAndTrack(_name, value) {
        stored.push(value);
      },
      async deleteAndTrack() {},
      async beginTx() {},
      async commitTx() {},
      async rollbackTx() {},
    };
    const record = makeRuntimeOutput({
      id: "runtime-output-clone",
      results: [{ text: "original" }],
    });

    await putClonedRecord(mutations, "runtime_outputs", record);
    (record.results as Array<{ text: string }>)[0]!.text = "mutated";

    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(record);
    expect(stored[0]).toMatchObject({
      id: "runtime-output-clone",
      results: [{ text: "original" }],
    });
  });

  it("filters runtime outputs then returns newest rows first with limit", () => {
    const older = makeRuntimeOutput({
      id: "older",
      pluginId: "story",
      runtimeId: "narrator",
      timestamp: "2024-01-01T00:00:00.000Z",
    });
    const newest = makeRuntimeOutput({
      id: "newest",
      pluginId: "story",
      runtimeId: "narrator",
      timestamp: "2024-01-03T00:00:00.000Z",
    });
    const otherRuntime = makeRuntimeOutput({
      id: "other-runtime",
      pluginId: "story",
      runtimeId: "guide",
      timestamp: "2024-01-04T00:00:00.000Z",
    });
    const otherPlugin = makeRuntimeOutput({
      id: "other-plugin",
      pluginId: "world",
      runtimeId: "narrator",
      timestamp: "2024-01-05T00:00:00.000Z",
    });
    const middle = makeRuntimeOutput({
      id: "middle",
      pluginId: "story",
      runtimeId: "narrator",
      timestamp: "2024-01-02T00:00:00.000Z",
    });

    const rows = filterRuntimeOutputs(
      [older, newest, otherRuntime, otherPlugin, middle],
      {
        pluginId: "story",
        runtimeId: "narrator",
        sinceTimestamp: "2024-01-02T00:00:00.000Z",
        limit: 1,
      },
    );

    expect(rows.map((row) => row.id)).toEqual(["newest"]);
  });

  it("filters interaction records and keeps newest-first order", () => {
    const keepNewest = makeInteractionRecord({
      id: "keep-newest",
      source: "plugin-ui",
      targetPluginId: "inventory",
      type: "form-submit",
      timestamp: "2024-01-03T00:00:00.000Z",
    });
    const keepOlder = makeInteractionRecord({
      id: "keep-older",
      source: "plugin-ui",
      targetPluginId: "inventory",
      type: "form-submit",
      timestamp: "2024-01-02T00:00:00.000Z",
    });
    const wrongSource = makeInteractionRecord({
      id: "wrong-source",
      source: "player",
      targetPluginId: "inventory",
      type: "form-submit",
      timestamp: "2024-01-04T00:00:00.000Z",
    });
    const wrongTarget = makeInteractionRecord({
      id: "wrong-target",
      source: "plugin-ui",
      targetPluginId: "map",
      type: "form-submit",
      timestamp: "2024-01-05T00:00:00.000Z",
    });

    const rows = filterInteractionRecords(
      [keepOlder, wrongSource, keepNewest, wrongTarget],
      {
        source: "plugin-ui",
        targetPluginId: "inventory",
        type: "form-submit",
        limit: 2,
      },
    );

    expect(rows.map((row) => row.id)).toEqual(["keep-newest", "keep-older"]);
  });

  it("sorts by createdAt before applying offset pagination", () => {
    const newest = makeTurnMessage({
      id: "newest",
      createdAt: "2024-01-03T00:00:00.000Z",
    });
    const oldest = makeTurnMessage({
      id: "oldest",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    const middle = makeTurnMessage({
      id: "middle",
      createdAt: "2024-01-02T00:00:00.000Z",
    });

    const page = paginateRows(sortByCreatedAtAsc([newest, oldest, middle]), {
      offset: 1,
      limit: 1,
    });

    expect(page.map((row) => row.id)).toEqual(["middle"]);
  });
});
