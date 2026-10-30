import { describe, expect, it } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest, SubscriptionEvent } from "@covel/shared";
import { suspendTool, suspendFieldsToResumeSchema } from "@covel/tools";
import type { FormField } from "@covel/plugin-handlers-utils";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import {
  makeExecutor,
  prose,
  queuedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const fields: FormField[] = [
  { type: "text", name: "name", label: "Your name", required: true },
  { type: "number", name: "age", label: "Age", min: 1, max: 100 },
];
const schema = suspendFieldsToResumeSchema(fields);
const runtime: RuntimeManifest = {
  name: "probe/ask",
  pluginId: "probe",
  description: "Ask for input",
  runtimeType: "agent",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  tools: { builtin: ["suspend"] },
};

describe.each(["form", "raw sentinel"])("suspension from a %s", (kind) => {
  it("stores and streams the answer schema, then completes after a valid answer", async () => {
    const store = createMemoryStore();
    const eventBus = createEventBus();
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((event) => events.push(event));
    const now = "2026-10-29T00:00:00.000Z";
    await store.createSession({
      id: "session",
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["probe"],
      completedPlayerTurns: 0,
      createdAt: now,
      updatedAt: now,
    });
    const input = {
      sessionId: "session",
      turnId: "turn",
      playerMessage: "Ask",
      origin: "player" as const,
    };
    const deps = {
      store,
      eventBus,
      llm: queuedLLM([toolCall("suspend", { reason: "Need input", fields })]),
      toolExecutor: makeExecutor([
        kind === "form"
          ? suspendTool
          : {
              ...suspendTool,
              execute: async () => ({
                _covelSuspend: true,
                reason: "Need input",
                resumeSchema: schema,
              }),
            },
      ]),
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "Ask for the name.",
      }),
    };
    try {
      const execution = await executeTurn(input, [runtime], deps);
      expect(
        (
          await commitExecution({
            store,
            eventBus,
            execution,
            completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
          })
        ).status,
      ).toBe("committed");
      const [suspension] = await store.listSuspensions("session");
      expect(suspension?.resumeSchema).toEqual(schema);
      expect(
        events.find((event) => event.type === "turn.suspended")?.payload,
      ).toMatchObject({ resumeSchema: schema });
      const resumed = await resumeSuspendedRuntime(
        suspension!,
        { name: "Alex", age: 21 },
        runtime,
        { ...deps, llm: queuedLLM([prose("All answered.")]) },
      );
      expect(resumed.result.status).toBe("success");
      expect(
        (
          await commitExecution({
            store,
            eventBus,
            execution: resumed,
            completion: {
              kind: "resume",
              turnId: suspension!.turnId,
              suspensionId: suspension!.id,
              pluginId: runtime.pluginId,
              runtimeId: runtime.name,
            },
          })
        ).status,
      ).toBe("committed");
      expect(
        (await store.getSuspension(suspension!.id))?.resolvedAt,
      ).toBeDefined();
    } finally {
      await eventBus.close();
      await store.close();
    }
  });
});
