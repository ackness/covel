import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../src/builtin/default-tools.js";
import type { DefaultToolRegistryDeps } from "../src/builtin/default-tools.js";

describe("default tool registry", () => {
  it("registers the same host built-ins when a store and event directory are supplied", () => {
    const store = {} as DefaultToolRegistryDeps["store"];
    const eventDirectory: DefaultToolRegistryDeps["eventDirectory"] = {
      async listTopics() {
        return [];
      },
      async validate() {
        return { ok: false, reason: "not configured" };
      },
    };
    const registry = createDefaultToolRegistry({ store, eventDirectory });

    expect([...registry.builtinTools.keys()].sort()).toEqual(
      [
        "render-ui",
        "create-form",
        "create-choices",
        "create-notification",
        "suspend",
        "runtime-done",
        "delegate",
        "plugin-data-set",
        "plugin-data-set-batch",
        "plugin-data-get",
        "plugin-data-list",
        "emit-event",
        "sync-characters",
        "list-characters",
        "get-character",
        "world-dimension-get",
        "world-dimension-list",
      ].sort(),
    );

    // Tool definitions are instructions and go to the model in every session
    // language. A Chinese description is Chinese context in an English
    // session, and the model starts answering in Chinese.
    for (const [name, module] of registry.builtinTools) {
      const definition = JSON.stringify([
        module.description,
        module.jsonSchema,
      ]);
      expect(definition, `tool ${name}`).not.toMatch(
        /[\u3040-\u30ff\u4e00-\u9fff]/,
      );
    }
  });
});

it("describes explicit runtime completion without changing its result", async () => {
  const {
    runtimeDoneTool,
    getToolContent,
    getModelView,
    isRuntimeDoneSentinel,
  } = await import("../src/index.js");
  expect(runtimeDoneTool.description).toContain("Call this last");
  expect(runtimeDoneTool.description).toContain(
    "every needed tool call has succeeded or when nothing needs doing",
  );
  expect(runtimeDoneTool.description).toContain("records nothing");
  expect(runtimeDoneTool.description).toContain("run ends after this response");
  expect(runtimeDoneTool.description).toContain(
    "do not make more calls or write more prose",
  );
  const result = await runtimeDoneTool.execute(
    { reason: "Finished" },
    {
      sessionId: "session",
      turnId: "turn",
      pluginId: "probe",
      runtimeId: "probe/run",
      random: { int: (min: number) => min },
    },
  );
  expect(getToolContent(result)).toEqual({
    _covelRuntimeDone: true,
    reason: "Finished",
  });
  expect(isRuntimeDoneSentinel(getToolContent(result))).toBe(true);
  expect(getModelView(result)).toEqual({ summary: "Run finished." });
});
