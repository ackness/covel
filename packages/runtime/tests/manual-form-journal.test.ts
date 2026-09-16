import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createFormTool } from "@covel/tools";
import type { InteractionPayload, RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { collectExecutionJournal } from "../src/execution-journal.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { submitFormHandler } from "../src/rpc-defaults/submit-form.js";

const form = {
  formId: "manual-form",
  title: "Check",
  fields: [{ type: "text", name: "action", label: "Action", required: true }],
  submitLabel: "Continue",
  narrativeTemplate: "{{action}}",
};

describe.each(["function", "agent"] as const)(
  "manual %s forms",
  (runtimeType) => {
    it.each([false, true])(
      "commits the validation template with the form (rollback: %s)",
      async (rollback) => {
        const store = createMemoryStore();
        const now = new Date().toISOString();
        await store.createSession({
          id: "s",
          worldId: null,
          phase: "playing",
          status: "active",
          completedPlayerTurns: 1,
          setupRuntimes: {},
          activePlugins: ["external"],
          createdAt: now,
          updatedAt: now,
        });
        const manifest: RuntimeManifest = {
          pluginId: "external",
          name: "external/form",
          description: "Form",
          runtimeType,
          trigger: { type: "manual" },
          outputKind: "system",
          tools: { builtin: ["create-form"] },
        };
        let calls = 0;
        const result = await executeTurn(
          {
            sessionId: "s",
            turnId: "t",
            origin: "manual",
            playerMessage: "",
            manualTrigger: { runtimeId: manifest.name },
          },
          [manifest],
          {
            store,
            loadRuntime: async () => ({
              manifest,
              promptTemplate: "",
              ...(runtimeType === "function"
                ? {
                    handler: async () => ({
                      outcome: "success" as const,
                      effects: {
                        interactions: [
                          (
                            (await createFormTool.execute(form, {
                              sessionId: "s",
                              pluginId: "external",
                              runtimeId: manifest.name,
                              turnId: "t",
                            })) as { interaction: InteractionPayload }
                          ).interaction,
                        ],
                      },
                    }),
                  }
                : {}),
            }),
            llm: {
              generate: async () => ({
                content: calls++ === 0 ? "" : "Ready",
                toolCalls:
                  calls === 1
                    ? [
                        {
                          id: "form-call",
                          name: "create-form",
                          arguments: JSON.stringify(form),
                        },
                      ]
                    : [],
                finishReason: calls === 1 ? "tool_calls" : "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            },
            toolExecutor: createToolExecutor({
              findTool: (name) =>
                name === "create-form" ? createFormTool : undefined,
              getToolSource: () => "builtin",
            }),
          },
        );
        expect(result.runtimeResults[0]?.status).toBe("success");
        expect(collectExecutionJournal(result)).toMatchObject([
          {
            sourcePluginId: "external",
            content: "",
            pendingInput: [{ interactionId: "manual-form" }],
          },
        ]);
        const payload = {
          turnId: "t",
          submissions: [
            {
              interactionId: "manual-form",
              type: "form",
              values: { action: "Climb" },
            },
          ],
        };
        const context = { sessionId: "s", pluginId: "framework", store };
        await expect(submitFormHandler(payload, context)).rejects.toThrow(
          "committed interaction",
        );
        await finalizeExecution({
          store,
          sessionId: "s",
          executionContext: result.executionContext,
          runtimes: [manifest],
          results: result.runtimeResults,
          journalMessages: collectExecutionJournal(result),
          turnIds: ["t"],
          ...(rollback
            ? {
                extraInTx: async () => {
                  throw new Error("Rollback fixture");
                },
              }
            : {}),
        });
        if (rollback) {
          await expect(submitFormHandler(payload, context)).rejects.toThrow(
            "committed interaction",
          );
          expect(await store.listTurnMessages("s")).toEqual([]);
        } else {
          await expect(
            submitFormHandler(payload, context),
          ).resolves.toMatchObject({ accepted: true });
          expect((await store.listTurnMessages("s"))[0]?.sourcePluginId).toBe(
            "external",
          );
        }
        expect((await store.getSession("s"))?.completedPlayerTurns).toBe(1);
      },
    );
  },
);
