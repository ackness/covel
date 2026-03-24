import { describe, it } from "vitest";

import {
  ArchiveVersionSchema,
  RetrievalRunSchema,
  TraceRecordSchema
} from "../src/index.js";
import {
  expectSchemaAccepts,
  expectSchemaRejects
} from "./helpers.js";

describe("TraceRecordSchema", () => {
  it("accepts a trace node with correlation metadata", () => {
    expectSchemaAccepts(TraceRecordSchema, {
      traceId: "tr_01",
      spanId: "sp_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      component: "flow-engine",
      eventType: "model.call.started",
      payload: {
        provider: "dashscope"
      },
      createdAt: "2026-03-24T12:00:00Z"
    });
  });

  it("rejects records missing their component and createdAt", () => {
    expectSchemaRejects(TraceRecordSchema, {
      traceId: "tr_01",
      spanId: "sp_01",
      sessionId: "ses_01",
      turnId: "turn_01",
      eventType: "model.call.started",
      payload: {}
    });
  });
});

describe("RetrievalRunSchema", () => {
  it("accepts a complete retrieval execution record", () => {
    expectSchemaAccepts(RetrievalRunSchema, {
      id: "ret_01",
      sessionId: "ses_01",
      query: "cave entrance",
      rewrittenQueries: ["cave entrance", "nearby cave"],
      selectedSources: ["world", "archives"],
      candidates: [
        {
          chunkId: "chk_01",
          score: 0.91
        }
      ],
      selectedChunks: [
        {
          chunkId: "chk_01",
          documentId: "doc_01"
        }
      ],
      critique: {
        sufficient: true
      },
      latencyMs: 42
    });
  });

  it("rejects incomplete retrieval records", () => {
    expectSchemaRejects(RetrievalRunSchema, {
      id: "ret_01",
      sessionId: "ses_01",
      query: "cave entrance"
    });
  });
});

describe("ArchiveVersionSchema", () => {
  it("accepts an archive version snapshot", () => {
    expectSchemaAccepts(ArchiveVersionSchema, {
      id: "arc_01",
      sessionId: "ses_01",
      turnCutoff: 12,
      stateSnapshot: {
        scene: "cave"
      },
      workingSummary: "探索者抵达洞口。",
      archiveSummary: "会话已整理为长期摘要。",
      createdAt: "2026-03-24T12:00:00Z"
    });
  });

  it("rejects archive versions missing required snapshot fields", () => {
    expectSchemaRejects(ArchiveVersionSchema, {
      id: "arc_01",
      sessionId: "ses_01",
      turnCutoff: 12
    });
  });
});
