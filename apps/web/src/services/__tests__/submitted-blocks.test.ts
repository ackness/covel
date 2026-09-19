import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  getSubmittedBlocks,
  removeSubmittedBlocks,
  saveSubmittedBlocks,
} from "../app-kv-store.js";

describe("submitted block persistence", () => {
  it("captures submitted ids and nested values before asynchronous storage work", async () => {
    const sessionId = `owned-form-${crypto.randomUUID()}`;
    const ids = ["form"];
    const values = { form: { choice: { score: 7 } } };
    const saving = saveSubmittedBlocks(sessionId, ids, values);
    ids.push("later");
    values.form.choice.score = 99;
    await saving;
    expect(await getSubmittedBlocks(sessionId)).toEqual({
      ids: ["form"],
      values: { form: { choice: { score: 7 } } },
    });
    await removeSubmittedBlocks(sessionId);
  });

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
