/**
 * {{pluginName}} plugin tests
 */

import { describe, expect, it } from "vitest";
import {
  getPendingProposals,
  tool,
  withPendingProposals,
  z,
} from "@covel/tools";
import createRecordNote from "../tools/record-note.js";

const toolInstance = createRecordNote({
  tool,
  z,
  withPendingProposals,
  shortId: (prefix, label) =>
    `${prefix}-${label.toLowerCase().replace(/\s+/g, "-")}`,
});

const ctx = {
  sessionId: "sess-test",
  turnId: "turn-1",
  pluginId: "{{pluginName}}",
  runtimeId: "{{pluginName}}",
};

describe("record-note tool", () => {
  it("records a note and attaches a plugin-data proposal", async () => {
    const result = await toolInstance.execute(
      {
        title: "Opened vault",
        text: "The player opened the sealed vault and found a silver key.",
        tags: ["quest"],
      },
      ctx,
    );

    expect(result.recorded).toBe(true);
    expect(result.key).toBe("note-opened-vault");

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      payload: {
        namespace: "notes",
        key: "note-opened-vault",
      },
    });
  });
});
