import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRuntimeDebug } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

describe("runner alignment with server host", () => {
  it("validates write-service dataset writes against provider schemas at commit", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-harness-dataset-validation-"),
    );
    roots.push(root);
    await writeFiles(root, {
      "provider/package.json": '{"type":"module"}',
      "provider/PLUGIN.md": `---
version: "0.1.0"
description: Entry-only write-service provider with strict dataset schema
entry: ./entry.js
contributes:
  datasets:
    notes:
      schema: ./schemas/note.schema.json
      key: id
  services:
    - contract: probe.write-notes@1
      access: write
---
`,
      "provider/schemas/note.schema.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "count"],
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          count: { type: "integer", minimum: 0 },
        },
      }),
      "provider/entry.js": `export default (covel) => {
        covel.registerService({
          name: "write-note",
          contract: "probe.write-notes@1",
          access: "write",
          input: covel.toolkit.z.object({
            key: covel.toolkit.z.string(),
            record: covel.toolkit.z.record(covel.toolkit.z.string(), covel.toolkit.z.unknown()),
          }),
          output: covel.toolkit.z.object({ staged: covel.toolkit.z.boolean() }),
          handler: async ({ key, record }, ctx) => {
            await ctx.pluginData.set("notes", key, record);
            return { staged: true };
          },
        });
      };`,
      "caller/package.json": '{"type":"module"}',
      "caller/PLUGIN.md": `---
version: "0.1.0"
description: Calls the provider write service
runtime:
  schedule: { trigger: { type: manual } }
  function: { handler: ./handler.js }
---
`,
      "caller/handler.js": `export default async (ctx) => {
        await ctx.services.call({
          pluginId: "provider",
          name: "write-note",
          contract: "probe.write-notes@1",
          input: ctx.manualPayload,
        });
        return { outcome: "success", value: { called: true } };
      };`,
    });

    const invalid = await runRuntimeDebug({
      runtimeId: "caller",
      pluginsDir: root,
      withPlugins: ["provider"],
      payload: {
        key: "note-1",
        record: { id: "note-1", title: "Bad", count: "not-a-number" },
      },
    });
    expect(invalid.commitStatus).toBe("failed");
    expect(invalid.commitError).toMatch(/count|integer|schema/i);

    const valid = await runRuntimeDebug({
      runtimeId: "caller",
      pluginsDir: root,
      withPlugins: ["provider"],
      payload: {
        key: "note-1",
        record: { id: "note-1", title: "Good", count: 3 },
      },
    });
    expect(valid.commitStatus, valid.commitError).toBe("committed");
  });

  it("wires declared plugin events into emit-event validation and agent prompt catalogs", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "covel-harness-event-directory-"),
    );
    roots.push(root);
    await writeFiles(root, {
      "consumer/package.json": '{"type":"module"}',
      "consumer/PLUGIN.md": `---
version: "0.1.0"
description: Declares public and internal events
contributes:
  events:
    - topic: probe.ping
      schema: ./schemas/ping.event.json
      description: Emit when a ping is observed.
    - topic: probe.internal
      schema: ./schemas/internal.event.json
      description: Internal only event.
      advertise: false
---
`,
      "consumer/schemas/ping.event.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1 },
        },
      }),
      "consumer/schemas/internal.event.json": JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      }),
      "consumer/runtimes/listener/RUNTIME.md": `---
description: Receives probe.ping
schedule:
  trigger: { type: event, topic: probe.ping }
  background: true
function: { handler: ./handler.js }
---
`,
      "consumer/runtimes/listener/handler.js": `export default async (ctx) => {
        return { outcome: "success", value: { seen: ctx.triggerEvent?.data } };
      };`,
      "emitter/package.json": '{"type":"module"}',
      "emitter/PLUGIN.md": `---
version: "0.1.0"
description: Agent runtime emitting events
runtime:
  schedule: { trigger: { type: manual } }
  agent:
    advertiseEvents: true
    tools:
      builtin: [emit-event]
---
Emit events when needed.
`,
    });

    const accepted = await runRuntimeDebug({
      runtimeId: "emitter",
      pluginsDir: root,
      withPlugins: ["consumer"],
      showPrompts: true,
      llmResponses: [
        {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-emit-valid",
              name: "emit-event",
              arguments: JSON.stringify({
                topic: "probe.ping",
                data: { message: "hello" },
              }),
            },
          ],
        },
        {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            { id: "tc-done", name: "submit-output", arguments: "{}" },
          ],
        },
      ],
    });
    expect(accepted.commitStatus, accepted.commitError).toBe("committed");
    const emitterResult = accepted.runtimeResults.find(
      (item) => item.runtimeId === "emitter",
    );
    expect(emitterResult?.status).toBe("success");
    expect(emitterResult?.toolCalls?.[0]).toMatchObject({
      toolName: "emit-event",
    });
    expect(JSON.stringify(emitterResult?.toolCalls?.[0]?.output)).not.toMatch(
      /error|rejected|unknown topic/i,
    );
    const promptDump = JSON.stringify(accepted.llmCalls);
    expect(promptDump).toContain("probe.ping");
    expect(promptDump).toContain("Emit when a ping is observed.");
    expect(promptDump).not.toContain("probe.internal");
    expect(
      accepted.runtimeResults.find(
        (item) => item.runtimeId === "consumer/listener",
      ),
    ).toMatchObject({
      status: "success",
      output: { seen: { message: "hello" } },
    });

    const rejected = await runRuntimeDebug({
      runtimeId: "emitter",
      pluginsDir: root,
      withPlugins: ["consumer"],
      showPrompts: true,
      llmResponses: [
        {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-bad-payload",
              name: "emit-event",
              arguments: JSON.stringify({
                topic: "probe.ping",
                data: { message: 123 },
              }),
            },
            {
              id: "tc-undeclared",
              name: "emit-event",
              arguments: JSON.stringify({
                topic: "probe.unknown",
                data: {},
              }),
            },
            {
              id: "tc-internal",
              name: "emit-event",
              arguments: JSON.stringify({
                topic: "probe.internal",
                data: {},
              }),
            },
          ],
        },
        {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            { id: "tc-done", name: "submit-output", arguments: "{}" },
          ],
        },
      ],
    });
    const secondCall = rejected.llmCalls[1] as {
      messages?: ReadonlyArray<{
        role?: string;
        toolCallId?: string;
        content?: string;
      }>;
    };
    const toolErrorFor = (id: string) => {
      const content =
        secondCall.messages?.find(
          (msg) => msg.role === "tool" && msg.toolCallId === id,
        )?.content ?? "{}";
      return (JSON.parse(content) as { error?: { message?: string } }).error
        ?.message;
    };
    expect(toolErrorFor("tc-bad-payload")).toMatch(/event payload rejected/i);
    expect(toolErrorFor("tc-undeclared")).toMatch(
      /unknown topic "probe\.unknown".*Available topics: probe\.ping/,
    );
    expect(toolErrorFor("tc-internal")).toMatch(
      /unknown topic "probe\.internal".*Available topics: probe\.ping/,
    );
    expect(rejected.deferredFollowers).toEqual([]);
  });
});
