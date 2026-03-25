import {
  DEFAULT_LOCALE,
  type ActionRequest,
  type BlockEnvelope,
  type BlockResponse,
  type SseEnvelope,
  type SupportedLocale
} from "../../contracts/src/index.js";
import type { Message, Session } from "../../domain/src/index.js";

export interface ModelTurnResult {
  content: string;
  blocks?: BlockEnvelope[];
  traceId?: string;
}

export interface ModelGateway {
  generateText(input: {
    sessionId: string;
    prompt: string;
    requestId: string;
    flowId: string;
    locale: SupportedLocale;
  }): Promise<ModelTurnResult>;
}

export interface CommandExecutionResult {
  content?: string;
  blocks?: BlockEnvelope[];
  traceId?: string;
}

export interface CommandBus {
  execute(input: {
    commandText: string;
    sessionId: string;
    requestId: string;
    locale: SupportedLocale;
  }): Promise<CommandExecutionResult>;
}

interface SessionRepository {
  getById(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
}

interface MessageRepository {
  save(message: Message): Promise<void>;
  listBySessionId(sessionId: string): Promise<Message[]>;
}

export interface PendingBlockRecord {
  blockId: string;
  sessionId: string;
  flowId: string;
  turnId: string;
  blockEnvelope?: Record<string, unknown>;
  packageName?: string;
  resumeHandler?: string;
}

export interface PendingBlockStore {
  save(record: PendingBlockRecord): Promise<void>;
  getByBlockId(blockId: string): Promise<PendingBlockRecord | null>;
  delete(blockId: string): Promise<void>;
}

export interface FlowDependencies {
  sessions: SessionRepository;
  messages: MessageRepository;
  modelGateway: ModelGateway;
  commandBus: CommandBus;
  pendingBlockStore?: PendingBlockStore;
  createId(prefix: string): string;
  now(): Date;
}

interface PendingBlockContext {
  block: BlockEnvelope;
  flowId: string;
  turnId: string;
}

export class FlowEngine {
  private readonly pendingBlocks = new Map<string, PendingBlockContext>();

  public constructor(private readonly dependencies: FlowDependencies) {}

  public async handle(action: ActionRequest): Promise<SseEnvelope[]> {
    switch (action.type) {
      case "send_message":
        return this.handleSendMessage(action);
      case "execute_command":
        return this.handleExecuteCommand(action);
      case "submit_block_response":
        return this.handleSubmitBlockResponse(action.payload, action.requestId, action.locale ?? DEFAULT_LOCALE);
    }
  }

  private async handleSendMessage(
    action: Extract<ActionRequest, { type: "send_message" }>
  ): Promise<SseEnvelope[]> {
    const locale = action.locale ?? DEFAULT_LOCALE;
    const session = await this.dependencies.sessions.getById(action.sessionId);
    if (!session) {
      return [this.createTerminalEvent("flow.failed", action.requestId, action.sessionId, this.dependencies.createId("flow"), {
        code: "SESSION_NOT_FOUND",
        message: translateFlowError("SESSION_NOT_FOUND", locale)
      })];
    }

    const flowId = this.dependencies.createId("flow");
    const turnId = this.dependencies.createId("turn");
    const userMessageId = this.dependencies.createId("msg");
    const assistantMessageId = this.dependencies.createId("msg");
    const events: SseEnvelope[] = [];
    let seq = 1;

    events.push(this.createEvent("flow.phase.changed", action.requestId, action.sessionId, turnId, flowId, seq++, {
      phase: "model"
    }));

    await this.dependencies.messages.save({
      id: userMessageId,
      sessionId: action.sessionId,
      role: "user",
      content: action.payload.content,
      createdAt: this.dependencies.now()
    });

    const result = await this.dependencies.modelGateway.generateText({
      sessionId: action.sessionId,
      prompt: action.payload.content,
      requestId: action.requestId,
      flowId,
      locale
    });

    events.push(this.createEvent("message.delta", action.requestId, action.sessionId, turnId, flowId, seq++, {
      messageId: assistantMessageId,
      delta: result.content
    }, result.traceId));
    events.push(this.createEvent("message.completed", action.requestId, action.sessionId, turnId, flowId, seq++, {
      messageId: assistantMessageId,
      content: result.content
    }, result.traceId));

    await this.dependencies.messages.save({
      id: assistantMessageId,
      sessionId: action.sessionId,
      role: "assistant",
      content: result.content,
      createdAt: this.dependencies.now()
    });

    if (result.blocks) {
      for (const block of result.blocks) {
        const emittedBlock = this.normalizeBlockEnvelope(block, {
          requestId: action.requestId,
          sessionId: action.sessionId,
          turnId,
          traceId: result.traceId
        });
        events.push(this.createEvent("block.emitted", action.requestId, action.sessionId, turnId, flowId, seq++, {
          block: emittedBlock
        }, result.traceId));

        if (emittedBlock.interaction.requiresResponse) {
          await this.rememberPendingBlock({
            block: emittedBlock,
            flowId,
            turnId
          });
          await this.dependencies.sessions.save({
            ...session,
            status: "waiting_for_input"
          });
        }
      }
    }

    events.push(this.createTerminalEvent("flow.completed", action.requestId, action.sessionId, flowId, {
      turnId
    }, result.traceId, seq));
    return events;
  }

  private async handleExecuteCommand(
    action: Extract<ActionRequest, { type: "execute_command" }>
  ): Promise<SseEnvelope[]> {
    const locale = action.locale ?? DEFAULT_LOCALE;
    const session = await this.dependencies.sessions.getById(action.sessionId);
    if (!session) {
      return [this.createTerminalEvent("flow.failed", action.requestId, action.sessionId, this.dependencies.createId("flow"), {
        code: "SESSION_NOT_FOUND",
        message: translateFlowError("SESSION_NOT_FOUND", locale)
      })];
    }

    const flowId = this.dependencies.createId("flow");
    const turnId = this.dependencies.createId("turn");
    const events: SseEnvelope[] = [];
    let seq = 1;

    events.push(this.createEvent("flow.phase.changed", action.requestId, action.sessionId, turnId, flowId, seq++, {
      phase: "command"
    }));

    const result = await this.dependencies.commandBus.execute({
      commandText: action.payload.command,
      sessionId: action.sessionId,
      requestId: action.requestId,
      locale
    });

    if (result.content) {
      const messageId = this.dependencies.createId("msg");
      events.push(this.createEvent("message.completed", action.requestId, action.sessionId, turnId, flowId, seq++, {
        messageId,
        content: result.content
      }, result.traceId));

      await this.dependencies.messages.save({
        id: messageId,
        sessionId: action.sessionId,
        role: "assistant",
        content: result.content,
        createdAt: this.dependencies.now()
      });
    }

    if (result.blocks) {
      for (const block of result.blocks) {
        const emittedBlock = this.normalizeBlockEnvelope(block, {
          requestId: action.requestId,
          sessionId: action.sessionId,
          turnId,
          traceId: result.traceId
        });
        events.push(this.createEvent("block.emitted", action.requestId, action.sessionId, turnId, flowId, seq++, {
          block: emittedBlock
        }, result.traceId));

        if (emittedBlock.interaction.requiresResponse) {
          await this.rememberPendingBlock({
            block: emittedBlock,
            flowId,
            turnId
          });
          await this.dependencies.sessions.save({
            ...session,
            status: "waiting_for_input"
          });
        }
      }
    }

    events.push(this.createTerminalEvent("flow.completed", action.requestId, action.sessionId, flowId, {
      turnId
    }, result.traceId, seq));
    return events;
  }

  private async handleSubmitBlockResponse(
    response: BlockResponse,
    requestId: string,
    locale: SupportedLocale = DEFAULT_LOCALE
  ): Promise<SseEnvelope[]> {
    const pending = await this.resolvePendingBlock(response.blockId);
    if (!pending || pending.block.meta.sessionId !== response.sessionId) {
      return [this.createTerminalEvent("flow.failed", requestId, response.sessionId, this.dependencies.createId("flow"), {
        code: "PENDING_BLOCK_NOT_FOUND",
        message: translateFlowError("PENDING_BLOCK_NOT_FOUND", locale)
      })];
    }

    const session = await this.dependencies.sessions.getById(pending.block.meta.sessionId);
    if (!session) {
      return [this.createTerminalEvent("flow.failed", requestId, pending.block.meta.sessionId, this.dependencies.createId("flow"), {
        code: "SESSION_NOT_FOUND",
        message: translateFlowError("SESSION_NOT_FOUND", locale)
      })];
    }

    const flowId = pending.flowId;
    const turnId = pending.turnId;
    const sessionId = pending.block.meta.sessionId;
    const events: SseEnvelope[] = [];
    let seq = 1;

    events.push(this.createEvent("flow.phase.changed", requestId, sessionId, turnId, flowId, seq++, {
      phase: "resume"
    }));

    const prompt = JSON.stringify({
      blockType: pending.block.type,
      handler: pending.block.interaction.resumeHandler ?? pending.block.meta.handler ?? null,
      response: response.response
    });
    const result = await this.dependencies.modelGateway.generateText({
      sessionId,
      prompt,
      requestId,
      flowId,
      locale
    });

    const messageId = this.dependencies.createId("msg");
    events.push(this.createEvent("message.completed", requestId, sessionId, turnId, flowId, seq++, {
      messageId,
      content: result.content
    }, result.traceId));

    await this.dependencies.messages.save({
      id: messageId,
      sessionId,
      role: "assistant",
      content: result.content,
      createdAt: this.dependencies.now()
    });

    this.pendingBlocks.delete(response.blockId);
    await this.dependencies.pendingBlockStore?.delete(response.blockId);
    await this.dependencies.sessions.save({
      ...session,
      status: "active"
    });

    events.push(this.createTerminalEvent("flow.completed", requestId, sessionId, flowId, {
      turnId
    }, result.traceId, seq));
    return events;
  }

  private createEvent(
    type: string,
    requestId: string,
    sessionId: string,
    turnId: string,
    flowId: string,
    seq: number,
    payload: Record<string, unknown>,
    traceId = "trace_local"
  ): SseEnvelope {
    return {
      type,
      requestId,
      traceId,
      sessionId,
      turnId,
      flowId,
      seq,
      timestamp: this.dependencies.now().toISOString(),
      payload
    };
  }

  private createTerminalEvent(
    type: "flow.completed" | "flow.failed",
    requestId: string,
    sessionId: string,
    flowId: string,
    payload: Record<string, unknown>,
    traceId = "trace_local",
    seq = 1
  ): SseEnvelope {
    const turnId = typeof payload.turnId === "string" ? payload.turnId : this.dependencies.createId("turn");
    return this.createEvent(type, requestId, sessionId, turnId, flowId, seq, payload, traceId);
  }

  private normalizeBlockEnvelope(
    block: BlockEnvelope,
    metadata: {
      requestId: string;
      sessionId: string;
      turnId: string;
      traceId?: string;
    }
  ): BlockEnvelope {
    return {
      ...block,
      id: this.dependencies.createId("block"),
      meta: {
        ...block.meta,
        requestId: metadata.requestId,
        traceId: metadata.traceId ?? "trace_local",
        sessionId: metadata.sessionId,
        turnId: metadata.turnId
      }
    };
  }

  private async rememberPendingBlock(input: PendingBlockContext): Promise<void> {
    this.pendingBlocks.set(input.block.id, input);
    await this.dependencies.pendingBlockStore?.save({
      blockId: input.block.id,
      sessionId: input.block.meta.sessionId,
      flowId: input.flowId,
      turnId: input.turnId,
      blockEnvelope: input.block as unknown as Record<string, unknown>,
      packageName: input.block.meta.package,
      resumeHandler: input.block.interaction.resumeHandler ?? input.block.meta.handler
    });
  }

  private async resolvePendingBlock(blockId: string): Promise<PendingBlockContext | null> {
    const inMemory = this.pendingBlocks.get(blockId);
    if (inMemory) {
      return inMemory;
    }

    const persisted = await this.dependencies.pendingBlockStore?.getByBlockId(blockId);
    if (!persisted) {
      return null;
    }

    if (persisted.blockEnvelope && isBlockEnvelopeLike(persisted.blockEnvelope)) {
      return {
        block: persisted.blockEnvelope,
        flowId: persisted.flowId,
        turnId: persisted.turnId
      };
    }

    return {
      block: {
        id: persisted.blockId,
        type: "pending",
        version: "1.0",
        meta: {
          package: persisted.packageName ?? "runtime",
          ...(persisted.resumeHandler ? { handler: persisted.resumeHandler } : {}),
          requestId: "restored",
          traceId: "trace_local",
          sessionId: persisted.sessionId,
          turnId: persisted.turnId
        },
        interaction: {
          requiresResponse: true,
          responseSchema: "",
          submitAs: "block_response",
          resumePolicy: "resume_current_flow",
          ...(persisted.resumeHandler ? { resumeHandler: persisted.resumeHandler } : {})
        },
        data: {}
      },
      flowId: persisted.flowId,
      turnId: persisted.turnId
    };
  }
}

function translateFlowError(
  code: "SESSION_NOT_FOUND" | "PENDING_BLOCK_NOT_FOUND",
  locale: SupportedLocale
): string {
  if (code === "SESSION_NOT_FOUND") {
    return locale === "en" ? "Session not found." : "未找到会话。";
  }

  return locale === "en" ? "Pending block not found." : "未找到待响应的交互块。";
}

function isBlockEnvelopeLike(value: Record<string, unknown>): value is BlockEnvelope {
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.version === "string" &&
    typeof value.meta === "object" &&
    value.meta !== null &&
    typeof value.interaction === "object" &&
    value.interaction !== null &&
    typeof value.data === "object" &&
    value.data !== null
  );
}
