import type { BlockEnvelope, SseEnvelope } from "../../../../modules/contracts/src/index.js";

export interface WebTimelineItem {
  id: string;
  kind: "message";
  role: string;
  content: string;
  status: "streaming" | "completed";
}

export interface WebState {
  activeSessionId: string | null;
  timeline: WebTimelineItem[];
  pendingBlocks: Record<string, BlockEnvelope>;
  requestStates: Record<string, { status: "streaming" | "completed" | "failed" }>;
  errors: Array<{
    terminal: boolean;
    message: string;
    code?: string;
  }>;
}

export function createInitialWebState(seed: Record<string, unknown> = {}): WebState {
  return {
    activeSessionId: typeof seed.activeSessionId === "string" ? seed.activeSessionId : null,
    timeline: [],
    pendingBlocks: {},
    requestStates: {},
    errors: []
  };
}

export function reduceSseEnvelope(state: WebState, envelope: SseEnvelope): WebState {
  const nextState: WebState = {
    activeSessionId: state.activeSessionId,
    timeline: state.timeline.map((item) => ({ ...item })),
    pendingBlocks: { ...state.pendingBlocks },
    requestStates: { ...state.requestStates },
    errors: [...state.errors]
  };

  const requestState = nextState.requestStates[envelope.requestId] ?? {
    status: "streaming" as const
  };
  nextState.requestStates[envelope.requestId] = requestState;

  if (envelope.type === "message.delta") {
    const messageId = String(envelope.payload.messageId ?? `msg_${envelope.seq}`);
    const existing = nextState.timeline.find((item) => item.id === messageId);
    if (existing) {
      existing.content += String(envelope.payload.delta ?? "");
      existing.status = "streaming";
    } else {
      nextState.timeline.push({
        id: messageId,
        kind: "message",
        role: String(envelope.payload.role ?? "assistant"),
        content: String(envelope.payload.delta ?? ""),
        status: "streaming"
      });
    }
    return nextState;
  }

  if (envelope.type === "message.completed") {
    const messageId = String(envelope.payload.messageId ?? `msg_${envelope.seq}`);
    const existing = nextState.timeline.find((item) => item.id === messageId);
    if (existing) {
      existing.status = "completed";
    }
    return nextState;
  }

  if (envelope.type === "block.emitted") {
    const block = envelope.payload.block as BlockEnvelope;
    nextState.pendingBlocks[block.id] = block;
    return nextState;
  }

  if (envelope.type === "block.updated") {
    const blockId = String(envelope.payload.blockId);
    nextState.pendingBlocks[blockId] = envelope.payload.block as BlockEnvelope;
    return nextState;
  }

  if (envelope.type === "error") {
    nextState.errors.push({
      terminal: false,
      message: String(envelope.payload.message ?? "Unknown error.")
    });
    return nextState;
  }

  if (envelope.type === "flow.failed") {
    nextState.requestStates[envelope.requestId] = {
      status: "failed"
    };
    nextState.errors.push({
      terminal: true,
      code: typeof envelope.payload.code === "string" ? envelope.payload.code : undefined,
      message: String(envelope.payload.message ?? "Flow failed.")
    });
    return nextState;
  }

  if (envelope.type === "flow.completed") {
    nextState.requestStates[envelope.requestId] = {
      status: "completed"
    };
  }

  return nextState;
}
