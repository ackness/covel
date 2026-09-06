import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  getSubmittedBlocks,
  removeSubmittedBlocks,
  saveSubmittedBlocks,
} from "../app-kv-store.js";

describe("submitted block persistence", () => {
  it("retains both submissions when concurrent writes start from the same record", async () => {
    const sessionId = "concurrent-submissions";
    await Promise.all([
      saveSubmittedBlocks(sessionId, ["first"], { first: { name: "Ada" } }),
      saveSubmittedBlocks(sessionId, ["second"], {
        second: { choice: "left" },
      }),
    ]);
    expect(await getSubmittedBlocks(sessionId)).toEqual({
      ids: ["first", "second"],
      values: { first: { name: "Ada" }, second: { choice: "left" } },
    });
    await removeSubmittedBlocks(sessionId);
  });

  it("updates one form without clearing another form or duplicating its id", async () => {
    const sessionId = "updated-submission";
    await saveSubmittedBlocks(sessionId, ["first", "second"], {
      first: { name: "Ada" },
      second: { choice: "left" },
    });
    await saveSubmittedBlocks(sessionId, ["first"], {
      first: { name: "Grace" },
    });
    await saveSubmittedBlocks(sessionId, ["second"], {});
    expect(await getSubmittedBlocks(sessionId)).toEqual({
      ids: ["first", "second"],
      values: { first: { name: "Grace" }, second: { choice: "left" } },
    });
    await removeSubmittedBlocks(sessionId);
    expect(await getSubmittedBlocks(sessionId)).toEqual({
      ids: [],
      values: {},
    });
  });
});
