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
  const modelCalls: Array<{ sessionId: string; prompt: string; requestId: string; flowId: string; locale: string }> = [];
  const commandCalls: Array<{ commandText: string; sessionId: string; requestId: string; locale: string }> = [];
  let idCounter = 0;
  const pendingBlocks = new Map<string, {
    blockId: string;
    sessionId: string;
    flowId: string;
    turnId: string;
    blockEnvelope?: Record<string, unknown>;
    packageName?: string;
    resumeHandler?: string;
  }>();

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
    pendingBlockStore: {
      async save(entry) {
        pendingBlocks.set(entry.blockId, entry);
      },
      async getByBlockId(blockId) {
        return pendingBlocks.get(blockId) ?? null;
      },
      async delete(blockId) {
        pendingBlocks.delete(blockId);
      }
    },
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
    commandCalls,
    pendingBlocks
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
    expect(harness.modelCalls[0]?.locale).toBe("zh-CN");
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
      locale: "en",
      payload: {
        command: "/guide",
        args: {
          topic: "ruins"
        }
      }
    });

    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.commandCalls[0]?.locale).toBe("en");
    expect(events.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "message.completed",
      "block.emitted",
      "flow.completed"
    ]);
    expect(events[2]?.payload.block).toMatchObject({
      id: "block_4",
      meta: {
        requestId: "req_02",
        sessionId: "session-1",
        turnId: "turn_2"
      }
    });
    expect(harness.sessions.get("session-1")?.status).toBe("waiting_for_input");
    expect(harness.pendingBlocks.get("block_4")).toMatchObject({
      packageName: "core-guide",
      blockEnvelope: expect.objectContaining({
        id: "block_4",
        type: "choices"
      })
    });
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
      locale: "en",
      payload: {
        command: "/guide",
        args: {}
      }
    });

    const initialFlowId = initialEvents[0]?.flowId;
    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as BlockEnvelope;

    const resumeEvents = await harness.engine.handle({
      requestId: "req_04",
      type: "submit_block_response",
      sessionId: "session-1",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session-1",
        turnId: emittedBlock.meta.turnId,
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
    expect(harness.modelCalls.at(-1)?.locale).toBe("en");
    expect(resumeEvents.every((event) => event.flowId === initialFlowId)).toBe(true);
    expect(harness.sessions.get("session-1")?.status).toBe("active");
  });

  it("resumes a pending interactive block after engine recreation by loading it from the pending block store", async () => {
    const choiceBlock: BlockEnvelope = {
      id: "blk_restart",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_restart",
        traceId: "tr_restart",
        sessionId: "session-1",
        turnId: "turn_restart"
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

    const firstHarness = createHarness({
      commandResult: {
        blocks: [choiceBlock],
        traceId: "trace_command"
      }
    });

    const initialEvents = await firstHarness.engine.handle({
      requestId: "req_06",
      type: "execute_command",
      sessionId: "session-1",
      locale: "en",
      payload: {
        command: "/guide",
        args: {}
      }
    });
    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as BlockEnvelope;

    const resumedHarness = createHarness({
      modelResult: {
        content: "You step deeper into the ruins.",
        traceId: "trace_model"
      }
    });
    resumedHarness.pendingBlocks.set(emittedBlock.id, {
      blockId: emittedBlock.id,
      sessionId: "session-1",
      flowId: initialEvents[0]!.flowId,
      turnId: emittedBlock.meta.turnId,
      packageName: emittedBlock.meta.package,
      blockEnvelope: emittedBlock as unknown as Record<string, unknown>
    });

    const resumeEvents = await resumedHarness.engine.handle({
      requestId: "req_07",
      type: "submit_block_response",
      sessionId: "session-1",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session-1",
        turnId: emittedBlock.meta.turnId,
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
    expect(resumeEvents.every((event) => event.flowId === initialEvents[0]?.flowId)).toBe(true);
    expect(resumedHarness.modelCalls.at(-1)?.prompt).toContain("\"blockType\":\"choices\"");
  });

  it("prefers a persisted resume handler from the stored block envelope", async () => {
    const harness = createHarness({
      modelResult: {
        content: "You continue from the stored resume handler.",
        traceId: "trace_model"
      }
    });

    harness.pendingBlocks.set("blk_saved", {
      blockId: "blk_saved",
      sessionId: "session-1",
      flowId: "flow_saved",
      turnId: "turn_saved",
      packageName: "director-choices",
      resumeHandler: "director.resumeChoice",
      blockEnvelope: {
        id: "blk_saved",
        type: "choice_set",
        version: "1.0",
        meta: {
          package: "director-choices",
          handler: "director.resumeChoice",
          requestId: "req_saved",
          traceId: "tr_saved",
          sessionId: "session-1",
          turnId: "turn_saved"
        },
        interaction: {
          requiresResponse: true,
          responseSchema: "schemas/blocks/choice-set.response.json",
          submitAs: "block_response",
          resumePolicy: "resume_current_flow",
          resumeHandler: "director.resumeChoice"
        },
        data: {
          title: "Choose",
          options: [{ id: "opt_a", label: "Advance" }]
        }
      }
    });

    const resumeEvents = await harness.engine.handle({
      requestId: "req_saved_resume",
      type: "submit_block_response",
      sessionId: "session-1",
      locale: "en",
      payload: {
        blockId: "blk_saved",
        blockType: "choice_set",
        sessionId: "session-1",
        turnId: "turn_saved",
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
    expect(harness.modelCalls.at(-1)?.prompt).toContain("\"handler\":\"director.resumeChoice\"");
    expect(harness.pendingBlocks.has("blk_saved")).toBe(false);
  });

  it("uses the persisted pending block turnId when resuming instead of trusting the client payload", async () => {
    const choiceBlock: BlockEnvelope = {
      id: "blk_turn_guard",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_turn_guard",
        traceId: "tr_turn_guard",
        sessionId: "session-1",
        turnId: "turn_turn_guard"
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
      requestId: "req_08",
      type: "execute_command",
      sessionId: "session-1",
      locale: "en",
      payload: {
        command: "/guide",
        args: {}
      }
    });
    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as BlockEnvelope;

    const resumeEvents = await harness.engine.handle({
      requestId: "req_09",
      type: "submit_block_response",
      sessionId: "session-1",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session-1",
        turnId: "turn_tampered",
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(resumeEvents.every((event) => event.turnId === emittedBlock.meta.turnId)).toBe(true);
  });

  it("rejects block responses that try to resume a pending block from another session", async () => {
    const choiceBlock: BlockEnvelope = {
      id: "blk_session_guard",
      type: "choices",
      version: "1.0",
      meta: {
        package: "core-guide",
        requestId: "req_session_guard",
        traceId: "tr_session_guard",
        sessionId: "session-1",
        turnId: "turn_session_guard"
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
      }
    });
    harness.sessions.set("session-2", createSession({
      id: "session-2",
      worldId: "world-1",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    }));

    const initialEvents = await harness.engine.handle({
      requestId: "req_10",
      type: "execute_command",
      sessionId: "session-1",
      locale: "en",
      payload: {
        command: "/guide",
        args: {}
      }
    });
    const emittedBlock = initialEvents.find((event) => event.type === "block.emitted")?.payload.block as BlockEnvelope;

    const resumeEvents = await harness.engine.handle({
      requestId: "req_11",
      type: "submit_block_response",
      sessionId: "session-2",
      locale: "en",
      payload: {
        blockId: emittedBlock.id,
        blockType: emittedBlock.type,
        sessionId: "session-2",
        turnId: emittedBlock.meta.turnId,
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(resumeEvents.map((event) => event.type)).toEqual(["flow.failed"]);
    expect(resumeEvents[0]?.payload).toMatchObject({
      code: "PENDING_BLOCK_NOT_FOUND",
      message: "Pending block not found."
    });
    expect(harness.modelCalls).toHaveLength(0);
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
    expect(events[0]?.payload).toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: "未找到会话。"
    });
    expect(harness.modelCalls).toHaveLength(0);
  });

  it("localizes pending block lookup failures in English", async () => {
    const harness = createHarness();

    const events = await harness.engine.handle({
      requestId: "req_06",
      type: "submit_block_response",
      sessionId: "session-1",
      locale: "en",
      payload: {
        blockId: "missing",
        blockType: "choices",
        sessionId: "session-1",
        turnId: "turn_01",
        response: {
          selected: "opt_a"
        }
      }
    });

    expect(events[0]?.payload).toMatchObject({
      code: "PENDING_BLOCK_NOT_FOUND",
      message: "Pending block not found."
    });
  });
});
