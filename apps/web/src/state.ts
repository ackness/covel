import type { SseEnvelope, TimelineItem, WorkspaceState } from "./types.js";

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    timeline: [],
    pendingBlock: null,
    lastTraceId: null
  };
}

export function applySseEvent(state: WorkspaceState, event: SseEnvelope): WorkspaceState {
  const nextState: WorkspaceState = {
    timeline: [...state.timeline],
    pendingBlock: state.pendingBlock,
    lastTraceId: event.traceId ?? state.lastTraceId
  };

  if (event.type === "message.delta") {
    const messageId = String(event.payload.messageId ?? `delta-${event.seq}`);
    const delta = String(event.payload.delta ?? "");
    const existing = nextState.timeline.find((item) => item.id === messageId);
    if (existing) {
      existing.content += delta;
      existing.streaming = true;
      return nextState;
    }

    nextState.timeline.push({
      id: messageId,
      role: "assistant",
      content: delta,
      streaming: true
    });
    return nextState;
  }

  if (event.type === "message.completed") {
    const messageId = String(event.payload.messageId ?? `completed-${event.seq}`);
    const content = String(event.payload.content ?? "");
    const existing = nextState.timeline.find((item) => item.id === messageId);
    if (existing) {
      existing.content = content;
      existing.streaming = false;
      return nextState;
    }

    nextState.timeline.push({
      id: messageId,
      role: "assistant",
      content,
      streaming: false
    });
    return nextState;
  }

  if (event.type === "block.emitted") {
    nextState.pendingBlock = event.payload.block as WorkspaceState["pendingBlock"];
    return nextState;
  }

  if (event.type === "flow.completed") {
    return nextState;
  }

  return nextState;
}

export function timelineFromMessages(messages: Array<{ id: string; role: "system" | "user" | "assistant"; content: string }>): TimelineItem[] {
  return messages
    .filter((message): message is { id: string; role: "user" | "assistant"; content: string } =>
      message.role === "assistant" || message.role === "user"
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      streaming: false
    }));
}
