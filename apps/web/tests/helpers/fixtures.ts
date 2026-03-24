import type {
  ArchiveVersion,
  BlockEnvelope,
  SseEnvelope
} from "../../../../modules/contracts/src/index.js";

export function createSseEnvelope(
  type: SseEnvelope["type"],
  seq: number,
  payload: SseEnvelope["payload"]
): SseEnvelope {
  return {
    type,
    requestId: "req_01",
    traceId: "tr_01",
    sessionId: "ses_01",
    turnId: "turn_01",
    flowId: "flow_01",
    seq,
    timestamp: new Date(Date.UTC(2026, 2, 24, 12, 0, seq)).toISOString(),
    payload
  };
}

export function createInteractiveBlock(overrides: Partial<BlockEnvelope> = {}): BlockEnvelope {
  return {
    id: "blk_01",
    type: "choices",
    version: "1.0",
    meta: {
      package: "core-guide",
      requestId: "req_01",
      traceId: "tr_01",
      sessionId: "ses_01",
      turnId: "turn_01"
    },
    interaction: {
      requiresResponse: true,
      responseSchema: "schemas/blocks/choices.response.json",
      submitAs: "block_response",
      resumePolicy: "resume_current_flow"
    },
    data: {
      title: "下一步做什么？",
      options: [
        {
          id: "opt_a",
          label: "继续前进"
        },
        {
          id: "opt_b",
          label: "调查回声"
        }
      ]
    },
    ...overrides
  };
}

export function createArchiveVersionFixture(
  overrides: Partial<ArchiveVersion> = {}
): ArchiveVersion {
  return {
    id: "arc_01",
    sessionId: "ses_01",
    turnCutoff: 3,
    stateSnapshot: {
      scene: "watchtower"
    },
    workingSummary: "队伍已经登上哨塔，并确认了下一步进入地窖。",
    archiveSummary: "第一幕总结：抵达北境哨塔，找到地窖入口。",
    createdAt: "2026-03-24T12:00:00.000Z",
    ...overrides
  };
}

export function createSessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_01",
    worldId: "world_01",
    status: "active",
    createdAt: "2026-03-24T12:00:00.000Z",
    ...overrides
  };
}

export function createWorldFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "world_01",
    name: "Northreach",
    description: "Frozen frontier",
    createdAt: "2026-03-24T12:00:00.000Z",
    ...overrides
  };
}
