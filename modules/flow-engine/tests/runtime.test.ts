import { describe, expect, it } from "vitest";

import type { BlockEnvelope } from "../../contracts/src/index.js";
import type { Session } from "../../domain/src/index.js";
import { createSession } from "../../domain/src/index.js";
import { FlowEngine, type CommandBus, type ModelGateway } from "../src/index.js";

function createHarness(options?: {
  modelResult?: { content: string; blocks?: BlockEnvelope[]; traceId?: string };
  commandResult?: { content?: string; blocks?: BlockEnvelope[]; traceId?: string };
  session?: Session | null;
}) {
  const session = options?.session ?? createSession({
    id: "session-1",
    worldId: "world-1",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  });

  const sessions = new Map<string, Session>();
  if (session) {
    sessions.set(session.id, session);
  }
  const messages: Array<{ id: string; sessionId: string; role: "user" | "assistant" | "system"; content: string; createdAt: Date }> = [];
  const modelCalls: Array<{ sessionId: string; prompt: string; requestId: string; flowId: string }> = [];
  const commandCalls: Array<{ commandText: string; sessionId: string; requestId: string }> = [];
  let idCounter = 0;

  const modelGateway: ModelGateway = {
    async generateText(input) {
      modelCalls.push(input);
      return options?.modelResult ?? {
        content: "The ruins answer in a low whisper.",
        traceId: "trace_model"
      };
    }
  };

  const commandBus: CommandBus = {
    async execute(input) {
      commandCalls.push(input);
      return options?.commandResult ?? {
        content: "Available commands: /help /memory /archive",
        traceId: "trace_command"
      };
    }
  };

  const engine = new FlowEngine({
    sessions: {
      async getById(id) {
        return sessions.get(id) ?? null;
      },
      async save(nextSession) {
        sessions.set(nextSession.id, nextSession);
      }
    },
    messages: {
      async save(message) {
        messages.push(message);
      },
      async listBySessionId(sessionId) {
        return messages.filter((message) => message.sessionId === sessionId);
      }
    },
    modelGateway,
    commandBus,
    createId(prefix) {
      idCounter += 1;
      return `${prefix}_${idCounter}`;
    },
    now() {
      return new Date("2026-03-24T12:00:00.000Z");
    }
  });

  return {
    engine,
    sessions,
    messages,
    modelCalls,
    commandCalls
  };
}

describe("FlowEngine", () => {
  it("runs send_message through model generation and emits terminal SSE events", async () => {
    const harness = createHarness();

    const events = await harness.engine.handle({
      requestId: "req_01",
      type: "send_message",
      sessionId: "session-1",
      payload: {
        content: "继续前进"
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "message.delta",
      "message.completed",
      "flow.completed"
    ]);
    expect(harness.modelCalls).toHaveLength(1);
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[0]?.role).toBe("user");
    expect(harness.messages[1]?.role).toBe("assistant");
  });

  it("routes execute_command through the command bus", async () => {
    const choiceBlock: BlockEnvelope = {
      id: "blk_01",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_02",
        traceId: "tr_01",
        sessionId: "session-1",
        turnId: "turn_1"
      },
      interaction: {
        requiresResponse: true,
        responseSchema: "schemas/blocks/choices.response.json",
        submitAs: "block_response",
        resumePolicy: "resume_current_flow"
      },
      data: {
        title: "下一步",
        options: [{ id: "opt_a", label: "继续前进" }]
      }
    };

    const harness = createHarness({
      commandResult: {
        content: "Guide generated.",
        traceId: "trace_command",
        blocks: [choiceBlock]
      }
    });

    const events = await harness.engine.handle({
      requestId: "req_02",
      type: "execute_command",
      sessionId: "session-1",
      payload: {
        command: "/guide",
        args: {
          topic: "ruins"
        }
      }
    });

    expect(harness.commandCalls).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "message.completed",
      "block.emitted",
      "flow.completed"
    ]);
    expect(harness.sessions.get("session-1")?.status).toBe("waiting_for_input");
  });

  it("resumes a pending interactive block on submit_block_response and reuses the original flowId", async () => {
    const choiceBlock: BlockEnvelope = {
      id: "blk_01",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_03",
        traceId: "tr_01",
        sessionId: "session-1",
        turnId: "turn_1"
      },
      interaction: {
        requiresResponse: true,
        responseSchema: "schemas/blocks/choices.response.json",
        submitAs: "block_response",
        resumePolicy: "resume_current_flow"
      },
      data: {
        title: "下一步",
        options: [{ id: "opt_a", label: "继续前进" }]
      }
    };

    const harness = createHarness({
      commandResult: {
        blocks: [choiceBlock],
        traceId: "trace_command"
      },
      modelResult: {
        content: "You step deeper into the ruins.",
        traceId: "trace_model"
      }
    });

    const initialEvents = await harness.engine.handle({
      requestId: "req_03",
      type: "execute_command",
      sessionId: "session-1",
      payload: {
        command: "/guide",
        args: {}
      }
    });

    const initialFlowId = initialEvents[0]?.flowId;

    const resumeEvents = await harness.engine.handle({
      requestId: "req_04",
      type: "submit_block_response",
      sessionId: "session-1",
      payload: {
        blockId: "blk_01",
        blockType: "choices",
        sessionId: "session-1",
        turnId: "turn_resume",
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(resumeEvents.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "message.completed",
      "flow.completed"
    ]);
    expect(resumeEvents.every((event) => event.flowId === initialFlowId)).toBe(true);
    expect(harness.sessions.get("session-1")?.status).toBe("active");
  });

  it("fails send_message when the session does not exist", async () => {
    const harness = createHarness({
      session: null
    });

    const events = await harness.engine.handle({
      requestId: "req_05",
      type: "send_message",
      sessionId: "missing-session",
      payload: {
        content: "继续前进"
      }
    });

    expect(events.map((event) => event.type)).toEqual(["flow.failed"]);
    expect(harness.modelCalls).toHaveLength(0);
  });
});
