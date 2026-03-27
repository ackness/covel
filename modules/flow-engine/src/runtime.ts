import {
  DEFAULT_LOCALE,
  type ActionRequest,
  type BlockEnvelope,
  type BlockResponse,
  type StatePatch,
  type SseEnvelope,
  type SupportedLocale,
  type WorkflowSignal,
  type WorkflowSnapshotRecord
} from "../../contracts/src/index.js";
import type { Message, Session } from "../../domain/src/index.js";

export interface ModelTurnResult {
  content: string;
  blocks?: BlockEnvelope[];
  statePatches?: StatePatch[];
  workflowEvents?: WorkflowSignal[];
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
  statePatches?: StatePatch[];
  workflowEvents?: WorkflowSignal[];
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

export interface ResumeExecutor {
  execute(input: {
    handler: string;
    block: BlockEnvelope;
    response: BlockResponse;
    sessionId: string;
    requestId: string;
    flowId: string;
    turnId: string;
    locale: SupportedLocale;
  }): Promise<CommandExecutionResult>;
}

export interface BlockValidationResult {
  ok: boolean;
  code?: "BLOCK_DATA_SCHEMA_INVALID" | "BLOCK_RESPONSE_SCHEMA_INVALID";
  details?: string;
}

export interface BlockValidator {
  validateData(block: BlockEnvelope): Promise<BlockValidationResult>;
  validateResponse(block: BlockEnvelope, response: BlockResponse): Promise<BlockValidationResult>;
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

export interface PackageStateStore {
  save(record: {
    scope: "world" | "session";
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
    value: Record<string, unknown>;
    updatedAt: Date;
  }): Promise<void>;
  get(input: {
    scope: "world" | "session";
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
  }): Promise<{
    scope: "world" | "session";
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
    value: Record<string, unknown>;
    updatedAt: Date;
  } | null>;
}

export interface WorkflowSnapshotStore {
  save(record: WorkflowSnapshotRecord): Promise<void>;
  getByRunId(runId: string): Promise<WorkflowSnapshotRecord | null>;
  listBySessionId(sessionId: string): Promise<WorkflowSnapshotRecord[]>;
}

export interface FlowDependencies {
  sessions: SessionRepository;
  messages: MessageRepository;
  modelGateway: ModelGateway;
  commandBus: CommandBus;
  resumeExecutor?: ResumeExecutor;
  pendingBlockStore?: PendingBlockStore;
  packageStateStore?: PackageStateStore;
  workflowSnapshotStore?: WorkflowSnapshotStore;
  blockValidator?: BlockValidator;
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
    let suspendedBlockId: string | null = null;

    events.push(this.createEvent("flow.phase.changed", action.requestId, action.sessionId, turnId, flowId, seq++, {
      phase: "model"
    }));
    await this.saveWorkflowSnapshot({
      runId: flowId,
      stepId: turnId,
      sessionId: action.sessionId,
      status: "running"
    });

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
        const blockValidation = await this.dependencies.blockValidator?.validateData(emittedBlock);
        if (blockValidation && !blockValidation.ok) {
          events.push(this.createTerminalEvent("flow.failed", action.requestId, action.sessionId, flowId, {
            turnId,
            code: blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
            message: translateFlowError(
              blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
              locale,
              blockValidation.details
            )
          }, result.traceId, seq));
          return events;
        }
        events.push(this.createEvent("block.emitted", action.requestId, action.sessionId, turnId, flowId, seq++, {
          block: emittedBlock
        }, result.traceId));

        if (emittedBlock.interaction.requiresResponse) {
          suspendedBlockId = emittedBlock.id;
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

    if (result.statePatches) {
      for (const patch of result.statePatches) {
        const applied = await this.applyStatePatch(patch);
        events.push(this.createEvent("state.patch.applied", action.requestId, action.sessionId, turnId, flowId, seq++, {
          patch,
          value: applied?.value ?? patch.value
        }, result.traceId));
      }
    }

    if (result.workflowEvents) {
      for (const workflowEvent of result.workflowEvents) {
        await this.saveWorkflowSnapshot({
          runId: workflowEvent.runId,
          stepId: workflowEvent.stepId,
          sessionId: action.sessionId,
          status: workflowEvent.type === "workflow.suspended" ? "suspended" : "running",
          ...(workflowEvent.type === "workflow.suspended"
            ? { suspendPayload: workflowEvent.payload ?? {} }
            : { resumeData: workflowEvent.payload ?? {} })
        });
        events.push(this.createEvent(workflowEvent.type, action.requestId, action.sessionId, turnId, flowId, seq++, {
          runId: workflowEvent.runId,
          stepId: workflowEvent.stepId,
          ...(workflowEvent.payload ? { ...workflowEvent.payload } : {})
        }, result.traceId));
      }
    }

    if (suspendedBlockId) {
      await this.saveWorkflowSnapshot({
        runId: flowId,
        stepId: turnId,
        sessionId: action.sessionId,
        status: "suspended",
        suspendPayload: {
          blockId: suspendedBlockId,
          reason: "await-block-response"
        }
      });
      events.push(this.createEvent("workflow.suspended", action.requestId, action.sessionId, turnId, flowId, seq++, {
        runId: flowId,
        stepId: turnId,
        status: "suspended",
        blockId: suspendedBlockId
      }, result.traceId));
    } else {
      await this.saveWorkflowSnapshot({
        runId: flowId,
        stepId: turnId,
        sessionId: action.sessionId,
        status: "completed"
      });
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
    let suspendedBlockId: string | null = null;

    events.push(this.createEvent("flow.phase.changed", action.requestId, action.sessionId, turnId, flowId, seq++, {
      phase: "command"
    }));
    await this.saveWorkflowSnapshot({
      runId: flowId,
      stepId: turnId,
      sessionId: action.sessionId,
      status: "running"
    });

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
        const blockValidation = await this.dependencies.blockValidator?.validateData(emittedBlock);
        if (blockValidation && !blockValidation.ok) {
          events.push(this.createTerminalEvent("flow.failed", action.requestId, action.sessionId, flowId, {
            turnId,
            code: blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
            message: translateFlowError(
              blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
              locale,
              blockValidation.details
            )
          }, result.traceId, seq));
          return events;
        }
        events.push(this.createEvent("block.emitted", action.requestId, action.sessionId, turnId, flowId, seq++, {
          block: emittedBlock
        }, result.traceId));

        if (emittedBlock.interaction.requiresResponse) {
          suspendedBlockId = emittedBlock.id;
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

    if (result.statePatches) {
      for (const patch of result.statePatches) {
        const applied = await this.applyStatePatch(patch);
        events.push(this.createEvent("state.patch.applied", action.requestId, action.sessionId, turnId, flowId, seq++, {
          patch,
          value: applied?.value ?? patch.value
        }, result.traceId));
      }
    }

    if (result.workflowEvents) {
      for (const workflowEvent of result.workflowEvents) {
        await this.saveWorkflowSnapshot({
          runId: workflowEvent.runId,
          stepId: workflowEvent.stepId,
          sessionId: action.sessionId,
          status: workflowEvent.type === "workflow.suspended" ? "suspended" : "running",
          ...(workflowEvent.type === "workflow.suspended"
            ? { suspendPayload: workflowEvent.payload ?? {} }
            : { resumeData: workflowEvent.payload ?? {} })
        });
        events.push(this.createEvent(workflowEvent.type, action.requestId, action.sessionId, turnId, flowId, seq++, {
          runId: workflowEvent.runId,
          stepId: workflowEvent.stepId,
          ...(workflowEvent.payload ? { ...workflowEvent.payload } : {})
        }, result.traceId));
      }
    }

    if (suspendedBlockId) {
      await this.saveWorkflowSnapshot({
        runId: flowId,
        stepId: turnId,
        sessionId: action.sessionId,
        status: "suspended",
        suspendPayload: {
          blockId: suspendedBlockId,
          reason: "await-block-response"
        }
      });
      events.push(this.createEvent("workflow.suspended", action.requestId, action.sessionId, turnId, flowId, seq++, {
        runId: flowId,
        stepId: turnId,
        status: "suspended",
        blockId: suspendedBlockId
      }, result.traceId));
    } else {
      await this.saveWorkflowSnapshot({
        runId: flowId,
        stepId: turnId,
        sessionId: action.sessionId,
        status: "completed"
      });
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
    let terminalTraceId = "trace_local";

    events.push(this.createEvent("flow.phase.changed", requestId, sessionId, turnId, flowId, seq++, {
      phase: "resume"
    }));

    const responseValidation = await this.dependencies.blockValidator?.validateResponse(pending.block, response);
    if (responseValidation && !responseValidation.ok) {
      events.push(this.createTerminalEvent("flow.failed", requestId, sessionId, flowId, {
        turnId,
        code: responseValidation.code ?? "BLOCK_RESPONSE_SCHEMA_INVALID",
        message: translateFlowError(
          responseValidation.code ?? "BLOCK_RESPONSE_SCHEMA_INVALID",
          locale,
          responseValidation.details
        )
      }, terminalTraceId, seq));
      return events;
    }

    await this.saveWorkflowSnapshot({
      runId: flowId,
      stepId: turnId,
      sessionId,
      status: "running",
      resumeData: response.response
    });
    events.push(this.createEvent("workflow.resumed", requestId, sessionId, turnId, flowId, seq++, {
      runId: flowId,
      stepId: turnId,
      status: "running",
      blockId: response.blockId
    }));

    const resumeHandler = pending.block.interaction.resumeHandler ?? pending.block.meta.handler;
    if (resumeHandler && this.dependencies.resumeExecutor) {
      const result = await this.dependencies.resumeExecutor.execute({
        handler: resumeHandler,
        block: pending.block,
        response,
        sessionId,
        requestId,
        flowId,
        turnId,
        locale
      });
      terminalTraceId = result.traceId ?? terminalTraceId;

      const nextSeq = await this.appendExecutionResultEvents({
        events,
        result,
        requestId,
        sessionId,
        turnId,
        flowId,
        nextSeq: seq,
        locale
      });
      if (nextSeq === null) {
        return events;
      }
      seq = nextSeq;
    } else {
      const prompt = JSON.stringify({
        blockType: pending.block.type,
        handler: resumeHandler ?? null,
        response: response.response
      });
      const result = await this.dependencies.modelGateway.generateText({
        sessionId,
        prompt,
        requestId,
        flowId,
        locale
      });
      terminalTraceId = result.traceId ?? terminalTraceId;

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
    }

    this.pendingBlocks.delete(response.blockId);
    await this.dependencies.pendingBlockStore?.delete(response.blockId);
    await this.dependencies.sessions.save({
      ...session,
      status: "active"
    });
    await this.saveWorkflowSnapshot({
      runId: flowId,
      stepId: turnId,
      sessionId,
      status: "completed",
      resumeData: response.response
    });

    events.push(this.createTerminalEvent("flow.completed", requestId, sessionId, flowId, {
      turnId
    }, terminalTraceId, seq));
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

  private async appendExecutionResultEvents(input: {
    events: SseEnvelope[];
    result: CommandExecutionResult;
    requestId: string;
    sessionId: string;
    turnId: string;
    flowId: string;
    nextSeq: number;
    locale: SupportedLocale;
  }): Promise<number | null> {
    let seq = input.nextSeq;

    if (input.result.content) {
      const messageId = this.dependencies.createId("msg");
      input.events.push(this.createEvent(
        "message.completed",
        input.requestId,
        input.sessionId,
        input.turnId,
        input.flowId,
        seq++,
        {
          messageId,
          content: input.result.content
        },
        input.result.traceId
      ));

      await this.dependencies.messages.save({
        id: messageId,
        sessionId: input.sessionId,
        role: "assistant",
        content: input.result.content,
        createdAt: this.dependencies.now()
      });
    }

    if (input.result.blocks) {
      for (const block of input.result.blocks) {
        const emittedBlock = this.normalizeBlockEnvelope(block, {
          requestId: input.requestId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          traceId: input.result.traceId
        });
        const blockValidation = await this.dependencies.blockValidator?.validateData(emittedBlock);
        if (blockValidation && !blockValidation.ok) {
          input.events.push(this.createTerminalEvent(
            "flow.failed",
            input.requestId,
            input.sessionId,
            input.flowId,
            {
              turnId: input.turnId,
              code: blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
              message: translateFlowError(
                blockValidation.code ?? "BLOCK_DATA_SCHEMA_INVALID",
                input.locale,
                blockValidation.details
              )
            },
            input.result.traceId,
            seq
          ));
          return null;
        }
        input.events.push(this.createEvent(
          "block.emitted",
          input.requestId,
          input.sessionId,
          input.turnId,
          input.flowId,
          seq++,
          {
            block: emittedBlock
          },
          input.result.traceId
        ));
      }
    }

    if (input.result.statePatches) {
      for (const patch of input.result.statePatches) {
        const applied = await this.applyStatePatch(patch);
        input.events.push(this.createEvent(
          "state.patch.applied",
          input.requestId,
          input.sessionId,
          input.turnId,
          input.flowId,
          seq++,
          {
            patch,
            value: applied?.value ?? patch.value
          },
          input.result.traceId
        ));
      }
    }

    if (input.result.workflowEvents) {
      for (const workflowEvent of input.result.workflowEvents) {
        await this.saveWorkflowSnapshot({
          runId: workflowEvent.runId,
          stepId: workflowEvent.stepId,
          sessionId: input.sessionId,
          status: workflowEvent.type === "workflow.suspended" ? "suspended" : "running",
          ...(workflowEvent.type === "workflow.suspended"
            ? { suspendPayload: workflowEvent.payload ?? {} }
            : { resumeData: workflowEvent.payload ?? {} })
        });
        input.events.push(this.createEvent(
          workflowEvent.type,
          input.requestId,
          input.sessionId,
          input.turnId,
          input.flowId,
          seq++,
          {
            runId: workflowEvent.runId,
            stepId: workflowEvent.stepId,
            ...(workflowEvent.payload ? { ...workflowEvent.payload } : {})
          },
          input.result.traceId
        ));
      }
    }

    return seq;
  }

  private async applyStatePatch(patch: StatePatch): Promise<{
    scope: "world" | "session";
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
    value: Record<string, unknown>;
    updatedAt: Date;
  } | null> {
    if (!this.dependencies.packageStateStore) {
      return null;
    }

    const existing = await this.dependencies.packageStateStore.get({
      scope: patch.scope,
      ownerId: patch.ownerId,
      packageName: patch.packageName,
      collection: patch.collection,
      key: patch.key
    });
    const nextValue = patch.op === "merge"
      ? {
          ...(existing?.value ?? {}),
          ...patch.value
        }
      : patch.value;
    const nextRecord = {
      scope: patch.scope,
      ownerId: patch.ownerId,
      packageName: patch.packageName,
      collection: patch.collection,
      key: patch.key,
      value: nextValue,
      updatedAt: this.dependencies.now()
    };

    await this.dependencies.packageStateStore.save(nextRecord);
    return nextRecord;
  }

  private async saveWorkflowSnapshot(record: {
    runId: string;
    stepId: string;
    sessionId: string;
    status: WorkflowSnapshotRecord["status"];
    suspendPayload?: Record<string, unknown>;
    resumeData?: Record<string, unknown>;
  }): Promise<void> {
    await this.dependencies.workflowSnapshotStore?.save({
      runId: record.runId,
      stepId: record.stepId,
      sessionId: record.sessionId,
      status: record.status,
      ...(record.suspendPayload ? { suspendPayload: record.suspendPayload } : {}),
      ...(record.resumeData ? { resumeData: record.resumeData } : {}),
      updatedAt: this.dependencies.now().toISOString()
    });
  }
}

function translateFlowError(
  code:
    | "SESSION_NOT_FOUND"
    | "PENDING_BLOCK_NOT_FOUND"
    | "BLOCK_DATA_SCHEMA_INVALID"
    | "BLOCK_RESPONSE_SCHEMA_INVALID",
  locale: SupportedLocale,
  details?: string
): string {
  if (code === "SESSION_NOT_FOUND") {
    return locale === "en" ? "Session not found." : "未找到会话。";
  }

  if (code === "PENDING_BLOCK_NOT_FOUND") {
    return locale === "en" ? "Pending block not found." : "未找到待响应的交互块。";
  }

  if (code === "BLOCK_DATA_SCHEMA_INVALID") {
    return locale === "en"
      ? `Interactive block data did not match schema.${details ? ` ${details}` : ""}`
      : `交互块数据未通过 schema 校验。${details ? ` ${details}` : ""}`;
  }

  return locale === "en"
    ? `Block response did not match schema.${details ? ` ${details}` : ""}`
    : `交互块响应未通过 schema 校验。${details ? ` ${details}` : ""}`;
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
