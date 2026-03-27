import type { BlockEnvelope } from "../../../modules/contracts/src/index.js";
import type {
  RuntimeArtifactItem,
  SseEnvelope,
  StatePatchEvent,
  TimelineBlockItem,
  TimelineItem,
  WorkflowRunItem,
  WorkspaceState
} from "./types.js";

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    timeline: [],
    pendingBlock: null,
    lastTraceId: null,
    recentArtifacts: [],
    recentStatePatches: [],
    workflowRuns: []
  };
}

export function applySseEvent(state: WorkspaceState, event: SseEnvelope): WorkspaceState {
  const nextState: WorkspaceState = {
    timeline: [...state.timeline],
    pendingBlock: state.pendingBlock,
    lastTraceId: event.traceId ?? state.lastTraceId,
    recentArtifacts: [...state.recentArtifacts],
    recentStatePatches: [...state.recentStatePatches],
    workflowRuns: [...state.workflowRuns]
  };

  if (event.type === "message.delta") {
    const messageId = String(event.payload.messageId ?? `delta-${event.seq}`);
    const delta = String(event.payload.delta ?? "");
    const existing = nextState.timeline.find((item): item is TimelineItem => item.kind === "message" && item.id === messageId);
    if (existing) {
      existing.content += delta;
      existing.streaming = true;
      return nextState;
    }

    nextState.timeline.push({
      kind: "message",
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
    const existing = nextState.timeline.find((item): item is TimelineItem => item.kind === "message" && item.id === messageId);
    if (existing) {
      existing.content = content;
      existing.streaming = false;
      return nextState;
    }

    nextState.timeline.push({
      kind: "message",
      id: messageId,
      role: "assistant",
      content,
      streaming: false
    });
    return nextState;
  }

  if (event.type === "block.emitted") {
    const block = event.payload.block as BlockEnvelope;
    nextState.pendingBlock = block;
    const existing = nextState.timeline.find((item): item is TimelineBlockItem => item.kind === "block" && item.id === block.id);
    if (existing) {
      existing.block = block;
      existing.pending = block.interaction.requiresResponse;
      return nextState;
    }

    nextState.timeline.push({
      kind: "block",
      id: block.id,
      block,
      pending: block.interaction.requiresResponse
    });
    return nextState;
  }

  if (event.type === "flow.completed") {
    const workflowIndex = nextState.workflowRuns.findIndex((item) => item.id === event.flowId);
    if (workflowIndex >= 0) {
      nextState.workflowRuns[workflowIndex] = {
        ...nextState.workflowRuns[workflowIndex]!,
        status: "completed",
        summary: nextState.workflowRuns[workflowIndex]?.currentStep
          ? `completed:${nextState.workflowRuns[workflowIndex]?.currentStep}`
          : "completed"
      };
    }
    return nextState;
  }

  if (event.type === "artifact.updated") {
    const artifact = toRuntimeArtifactItem(event);
    const existingIndex = nextState.recentArtifacts.findIndex((item) => item.id === artifact.id);
    if (existingIndex >= 0) {
      nextState.recentArtifacts[existingIndex] = artifact;
    } else {
      nextState.recentArtifacts.unshift(artifact);
      nextState.recentArtifacts = nextState.recentArtifacts.slice(0, 6);
    }
    return nextState;
  }

  if (event.type === "state.patch.applied") {
    const patchEvent = toStatePatchEvent(event);
    const existingIndex = nextState.recentStatePatches.findIndex((item) => item.id === patchEvent.id);
    if (existingIndex >= 0) {
      nextState.recentStatePatches[existingIndex] = patchEvent;
    } else {
      nextState.recentStatePatches.unshift(patchEvent);
      nextState.recentStatePatches = nextState.recentStatePatches.slice(0, 8);
    }
    return nextState;
  }

  if (event.type === "workflow.suspended" || event.type === "workflow.resumed") {
    const workflowRun = toWorkflowRunItem(event);
    const existingIndex = nextState.workflowRuns.findIndex((item) => item.id === workflowRun.id);
    if (existingIndex >= 0) {
      nextState.workflowRuns[existingIndex] = workflowRun;
    } else {
      nextState.workflowRuns.unshift(workflowRun);
      nextState.workflowRuns = nextState.workflowRuns.slice(0, 6);
    }
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
      kind: "message" as const,
      id: message.id,
      role: message.role,
      content: message.content,
      streaming: false
    }));
}

function toRuntimeArtifactItem(event: SseEnvelope): RuntimeArtifactItem {
  const payload = event.payload as Record<string, unknown>;
  const artifact = (payload.artifact as Record<string, unknown> | undefined) ?? payload;

  return {
    id: String(artifact.id ?? `artifact-${event.seq}`),
    kind: String(artifact.kind ?? "artifact"),
    mediaType: typeof artifact.mediaType === "string" ? artifact.mediaType : undefined,
    uri: typeof artifact.uri === "string" ? artifact.uri : undefined,
    title: typeof artifact.title === "string" ? artifact.title : undefined,
    status: typeof artifact.status === "string" ? artifact.status : undefined,
    traceId: event.traceId ?? null
  };
}

function toStatePatchEvent(event: SseEnvelope): StatePatchEvent {
  const payload = event.payload as Record<string, unknown>;
  const patch = (payload.patch as Record<string, unknown> | undefined) ?? payload;
  const target = String(patch.target ?? "state");
  const packageName = typeof patch.packageName === "string" ? patch.packageName : undefined;
  const scope = patch.scope && typeof patch.scope === "object"
    ? Object.entries(patch.scope as Record<string, unknown>)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")
    : undefined;

  return {
    id: String(patch.id ?? `${target}:${event.seq}`),
    target,
    packageName,
    scopeLabel: scope,
    summary: typeof patch.summary === "string"
      ? patch.summary
      : packageName
        ? `${packageName} -> ${target}`
        : target,
    traceId: event.traceId ?? null
  };
}

function toWorkflowRunItem(event: SseEnvelope): WorkflowRunItem {
  const payload = event.payload as Record<string, unknown>;
  const status = event.type === "workflow.suspended" ? "suspended" : "running";
  const runId = String(payload.runId ?? payload.workflowRunId ?? `workflow-${event.seq}`);
  const currentStep = typeof payload.currentStep === "string"
    ? payload.currentStep
    : typeof payload.stepId === "string"
      ? payload.stepId
      : undefined;
  const summary = typeof payload.summary === "string"
    ? payload.summary
    : typeof payload.reason === "string"
      ? payload.reason
      : currentStep
        ? `${status}:${currentStep}`
        : status;

  return {
    id: runId,
    workflowId: typeof payload.workflowId === "string" ? payload.workflowId : undefined,
    status,
    currentStep,
    summary,
    traceId: event.traceId ?? null
  };
}
