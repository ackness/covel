import { describe, expect, it } from "vitest";

import {
  buildEntityEdgeCandidates,
  buildRetrievedChunksFromDocuments,
  chunkMemoryDocument,
  createIngestionRegistry,
  expandRetrievedChunksByEntities,
  lexicalSearchRetrievedChunks,
  retrieveEntityAware,
  retrieveHybrid,
  tagRetrievedChunks,
  type MemoryDocument,
  type RetrievedChunk
} from "../src/index.js";

function createDocument(input: Partial<MemoryDocument> & Pick<MemoryDocument, "id" | "sourceType" | "scope" | "title" | "content">): MemoryDocument {
  return {
    metadata: {},
    provenance: { sourceId: input.id },
    ...input
  };
}

function createRetrievedChunk(id: string, sourceType: MemoryDocument["sourceType"]): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `${sourceType}-doc`,
    scope: `${sourceType}:scope`,
    sourceType,
    text: `${sourceType} content for ${id}`
  };
}

describe("chunkMemoryDocument", () => {
  it("uses heading-aware chunking for world and persona documents", () => {
    const worldChunks = chunkMemoryDocument(
      createDocument({
        id: "world-doc",
        sourceType: "world",
        scope: "world:northreach",
        title: "Northreach",
        content: [
          "# Geography",
          "Northreach is a frozen frontier.",
          "",
          "## Capital",
          "The capital city is Frostharbor.",
          "",
          "## Factions",
          "The Lantern Wardens guard the passes."
        ].join("\n")
      })
    );

    const personaChunks = chunkMemoryDocument(
      createDocument({
        id: "persona-doc",
        sourceType: "persona",
        scope: "persona:guide",
        title: "Guide persona",
        content: [
          "# Tone",
          "Speak plainly and avoid prophecy.",
          "",
          "## Boundaries",
          "Do not invent inventory the player does not own."
        ].join("\n")
      })
    );

    expect(worldChunks.map((chunk) => chunk.text)).toEqual([
      "Geography\nNorthreach is a frozen frontier.",
      "Capital\nThe capital city is Frostharbor.",
      "Factions\nThe Lantern Wardens guard the passes."
    ]);
    expect(worldChunks.every((chunk) => chunk.metadata.chunkStrategy === "heading-aware")).toBe(
      true
    );
    expect(worldChunks.every((chunk) => chunk.tokenCount <= 600)).toBe(true);

    expect(personaChunks.map((chunk) => chunk.text)).toEqual([
      "Tone\nSpeak plainly and avoid prophecy.",
      "Boundaries\nDo not invent inventory the player does not own."
    ]);
    expect(personaChunks.every((chunk) => chunk.metadata.chunkStrategy === "heading-aware")).toBe(
      true
    );
  });

  it("uses sliding-window chunking for archive transcripts", () => {
    const archiveChunks = chunkMemoryDocument(
      createDocument({
        id: "archive-doc",
        sourceType: "archive",
        scope: "archive:session-1",
        title: "Session archive",
        content: [
          "user: We enter the ruin.",
          "assistant: The gate opens with a metallic sigh.",
          "user: Search for the observatory key.",
          "assistant: You find the key beneath a cracked astrolabe."
        ].join("\n")
      })
    );

    expect(archiveChunks).toHaveLength(2);
    expect(archiveChunks.map((chunk) => chunk.text)).toEqual([
      "user: We enter the ruin.\nassistant: The gate opens with a metallic sigh.",
      "user: Search for the observatory key.\nassistant: You find the key beneath a cracked astrolabe."
    ]);
    expect(archiveChunks.every((chunk) => chunk.metadata.chunkStrategy === "sliding-window")).toBe(
      true
    );
    expect(archiveChunks.every((chunk) => chunk.tokenCount <= 450)).toBe(true);
  });
});

describe("retrieveHybrid", () => {
  it("fuses lexical and vector candidates by reciprocal rank, dedupes, and tags provenance", async () => {
    const result = await retrieveHybrid({
      query: "Where is the observatory key?",
      lexicalSearch: async () => [
        { ...createRetrievedChunk("chunk-a", "world"), lexicalScore: 0.9 },
        { ...createRetrievedChunk("chunk-b", "archive"), lexicalScore: 0.8 },
        { ...createRetrievedChunk("chunk-c", "persona"), lexicalScore: 0.7 }
      ],
      vectorSearch: async () => [
        { ...createRetrievedChunk("chunk-b", "archive"), vectorScore: 0.95 },
        { ...createRetrievedChunk("chunk-d", "world"), vectorScore: 0.9 },
        { ...createRetrievedChunk("chunk-a", "world"), vectorScore: 0.85 }
      ]
    });

    expect(result.mode).toBe("hybrid");
    expect(result.candidates.map((candidate) => candidate.chunkId)).toEqual([
      "chunk-b",
      "chunk-a",
      "chunk-d",
      "chunk-c"
    ]);
    expect(result.candidates[0]?.provenance).toEqual({
      sourceType: "archive",
      documentId: "archive-doc",
      chunkId: "chunk-b",
      scope: "archive:scope"
    });
  });

  it("falls back to the surviving retrieval branch when one branch fails", async () => {
    const lexicalFallback = await retrieveHybrid({
      query: "Where is the observatory key?",
      lexicalSearch: async () => [{ ...createRetrievedChunk("chunk-a", "world"), lexicalScore: 0.9 }],
      vectorSearch: async () => {
        throw new Error("vector offline");
      }
    });

    const vectorFallback = await retrieveHybrid({
      query: "Where is the observatory key?",
      lexicalSearch: async () => {
        throw new Error("fts offline");
      },
      vectorSearch: async () => [{ ...createRetrievedChunk("chunk-b", "archive"), vectorScore: 0.95 }]
    });

    expect(lexicalFallback.mode).toBe("fts-only");
    expect(lexicalFallback.candidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-a"]);
    expect(vectorFallback.mode).toBe("vector-only");
    expect(vectorFallback.candidates.map((candidate) => candidate.chunkId)).toEqual(["chunk-b"]);
  });
});

describe("entity-aware retrieval foundations", () => {
  it("builds retrieved chunks from documents and ranks lexical hits", () => {
    const documents = [
      createDocument({
        id: "world-doc",
        sourceType: "world",
        scope: "world:northreach",
        title: "Northreach",
        content: [
          "# Captain Mire",
          "Captain Mire commands the harbor watch.",
          "",
          "## Frostharbor",
          "Frostharbor answers to Captain Mire."
        ].join("\n")
      }),
      createDocument({
        id: "event-doc",
        sourceType: "archive",
        scope: "session:01",
        title: "Latest events",
        content: [
          "user: Ask about Captain Mire.",
          "assistant: Captain Mire distrusts the Lantern Wardens."
        ].join("\n")
      })
    ];

    const chunks = buildRetrievedChunksFromDocuments(documents);
    const lexical = lexicalSearchRetrievedChunks({
      query: "Captain Mire",
      chunks
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(lexical.map((chunk) => chunk.chunkId)).toEqual(
      expect.arrayContaining(["world-doc:0", "event-doc:0"])
    );
  });

  it("expands selected chunks through lightweight shared-entity edges", () => {
    const chunks: RetrievedChunk[] = [
      {
        chunkId: "chunk-a",
        documentId: "doc-a",
        scope: "world:1",
        sourceType: "world",
        text: "Captain Mire commands the harbor watch."
      },
      {
        chunkId: "chunk-b",
        documentId: "doc-b",
        scope: "world:1",
        sourceType: "world",
        text: "Frostharbor answers to Captain Mire and the harbor watch."
      },
      {
        chunkId: "chunk-c",
        documentId: "doc-c",
        scope: "world:1",
        sourceType: "world",
        text: "The Lantern Wardens patrol the northern pass."
      }
    ];

    const edges = buildEntityEdgeCandidates(chunks);
    const expanded = expandRetrievedChunksByEntities({
      selected: [chunks[0]!],
      allChunks: chunks
    });

    expect(edges.some((edge) => edge.entity.includes("captain mire"))).toBe(true);
    expect(expanded.map((chunk) => chunk.chunkId)).toContain("chunk-b");
  });

  it("runs entity-aware retrieval as hybrid selection plus graph expansion", async () => {
    const documents = [
      createDocument({
        id: "world-doc",
        sourceType: "world",
        scope: "world:northreach",
        title: "Northreach",
        content: [
          "# Captain Mire",
          "Captain Mire commands the harbor watch.",
          "",
          "## Harbor Watch",
          "The harbor watch reports to Captain Mire."
        ].join("\n")
      }),
      createDocument({
        id: "event-doc",
        sourceType: "archive",
        scope: "session:01",
        title: "Latest events",
        content: [
          "user: Ask about Captain Mire.",
          "assistant: Captain Mire distrusts the Lantern Wardens."
        ].join("\n")
      })
    ];

    const result = await retrieveEntityAware({
      query: "Captain Mire",
      documents
    });

    expect(result.mode).toBe("fts-only");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.expanded.length).toBeGreaterThan(0);
  });
});

describe("tagRetrievedChunks", () => {
  it("adds the required provenance fields to all selected chunks", () => {
    const tagged = tagRetrievedChunks([
      createRetrievedChunk("chunk-a", "world"),
      createRetrievedChunk("chunk-b", "archive")
    ]);

    expect(tagged.map((chunk) => chunk.provenance)).toEqual([
      {
        sourceType: "world",
        documentId: "world-doc",
        chunkId: "chunk-a",
        scope: "world:scope"
      },
      {
        sourceType: "archive",
        documentId: "archive-doc",
        chunkId: "chunk-b",
        scope: "archive:scope"
      }
    ]);
  });
});

describe("createIngestionRegistry", () => {
  it("marks repeated writes as idempotent and failures as stale until content changes", () => {
    const registry = createIngestionRegistry();

    const first = registry.register({
      sourceKey: "world:world-1",
      fingerprint: "hash-1"
    });
    const repeated = registry.register({
      sourceKey: "world:world-1",
      fingerprint: "hash-1"
    });

    registry.markFailed({
      sourceKey: "world:world-1",
      fingerprint: "hash-1",
      reason: "embedding failed"
    });

    const stale = registry.get("world:world-1");
    const changed = registry.register({
      sourceKey: "world:world-1",
      fingerprint: "hash-2"
    });

    expect(first).toEqual({
      action: "ingest",
      marker: {
        sourceKey: "world:world-1",
        fingerprint: "hash-1",
        stale: false,
        reason: null
      }
    });
    expect(repeated.action).toBe("noop");
    expect(stale).toEqual({
      sourceKey: "world:world-1",
      fingerprint: "hash-1",
      stale: true,
      reason: "embedding failed"
    });
    expect(changed).toEqual({
      action: "ingest",
      marker: {
        sourceKey: "world:world-1",
        fingerprint: "hash-2",
        stale: false,
        reason: null
      }
    });
  });
});
