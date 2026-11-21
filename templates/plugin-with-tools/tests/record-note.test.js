/**
 * {{pluginName}} plugin tests
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  getPendingProposals,
  getToolContent,
  shortId,
  tool,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { makeRandom } from "@covel/plugin-test-utils";
import createRecordNote from "../tools/record-note.js";

const toolInstance = createRecordNote({
  tool,
  z,
  shortId,
  withPendingProposals,
});

const ctx = {
  sessionId: "sess-test",
  turnId: "turn-1",
  pluginId: "{{pluginName}}",
  runtimeId: "{{pluginName}}",
};

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("scaffold workspace layout", () => {
  it("resolves workspace dependencies from the Covel root", () => {
    expect(existsSync(join(pluginDir, "pnpm-workspace.yaml"))).toBe(false);

    const rootWorkspace = resolve(pluginDir, "../..", "pnpm-workspace.yaml");
    expect(readFileSync(rootWorkspace, "utf8")).toContain('- "plugins/*"');
  });
});

describe("record-note tool", () => {
  it("records a note and attaches a plugin-data proposal", async () => {
    const expectedKey = shortId(
      "note",
      "Opened vault",
      ctx.sessionId,
      makeRandom(1),
    );
    const result = await toolInstance.execute(
      {
        title: "Opened vault",
        text: "The player opened the sealed vault and found a silver key.",
        tags: ["quest"],
      },
      { ...ctx, random: makeRandom(1) },
    );

    expect(getToolContent(result).recorded).toBe(true);
    expect(getToolContent(result).key).toBe(expectedKey);
    expect(expectedKey).toMatch(/^note-opened-vault-[0-9a-f]{8}$/);

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      payload: {
        namespace: "notes",
        key: expectedKey,
      },
    });
  });
});
