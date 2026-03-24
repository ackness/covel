import type { MemoryDocument as DomainMemoryDocument } from "../../domain/src/index.js";

export type MemoryDocument = DomainMemoryDocument & {
  sourceType: "world" | "persona" | "archive" | string;
};

export interface ChunkedMemory {
  chunkId: string;
  documentId: string;
  text: string;
  tokenCount: number;
  metadata: {
    chunkStrategy: "heading-aware" | "sliding-window";
  };
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  scope: string;
  sourceType: MemoryDocument["sourceType"];
  text: string;
  lexicalScore?: number;
  vectorScore?: number;
  provenance?: {
    sourceType: string;
    documentId: string;
    chunkId: string;
    scope: string;
  };
}

export interface HybridCandidate extends RetrievedChunk {
  fusedScore: number;
  provenance: {
    sourceType: string;
    documentId: string;
    chunkId: string;
    scope: string;
  };
}

export interface IngestionMarker {
  sourceKey: string;
  fingerprint: string;
  stale: boolean;
  reason: string | null;
}

export function chunkMemoryDocument(document: MemoryDocument): ChunkedMemory[] {
  if (document.sourceType === "archive") {
    const lines = document.content.split("\n").filter((line) => line.trim().length > 0);
    const chunks: ChunkedMemory[] = [];
    for (let index = 0; index < lines.length; index += 2) {
      const text = lines.slice(index, index + 2).join("\n");
      chunks.push({
        chunkId: `${document.id}:${chunks.length}`,
        documentId: document.id,
        text,
        tokenCount: estimateTokenCount(text),
        metadata: {
          chunkStrategy: "sliding-window"
        }
      });
    }
    return chunks;
  }

  const sections = document.content
    .split(/\n(?=#{1,6}\s)/g)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.map((section, index) => {
    const lines = section.split("\n").filter(Boolean);
    const heading = lines[0]?.replace(/^#{1,6}\s*/, "") ?? document.title;
    const body = lines.slice(1).join("\n");
    const text = body ? `${heading}\n${body}` : heading;

    return {
      chunkId: `${document.id}:${index}`,
      documentId: document.id,
      text,
      tokenCount: estimateTokenCount(text),
      metadata: {
        chunkStrategy: "heading-aware"
      }
    };
  });
}

export async function retrieveHybrid(input: {
  query: string;
  lexicalSearch: () => Promise<RetrievedChunk[]>;
  vectorSearch: () => Promise<RetrievedChunk[]>;
}): Promise<{
  mode: "hybrid" | "fts-only" | "vector-only";
  candidates: HybridCandidate[];
}> {
  let lexical: RetrievedChunk[] | null = null;
  let vector: RetrievedChunk[] | null = null;

  try {
    lexical = await input.lexicalSearch();
  } catch {
    lexical = null;
  }

  try {
    vector = await input.vectorSearch();
  } catch {
    vector = null;
  }

  if (!lexical && !vector) {
    return {
      mode: "hybrid",
      candidates: []
    };
  }

  if (lexical && !vector) {
    return {
      mode: "fts-only",
      candidates: fuseCandidates(lexical, [])
    };
  }

  if (!lexical && vector) {
    return {
      mode: "vector-only",
      candidates: fuseCandidates([], vector)
    };
  }

  return {
    mode: "hybrid",
    candidates: fuseCandidates(lexical ?? [], vector ?? [])
  };
}

export function tagRetrievedChunks(chunks: RetrievedChunk[]): Array<RetrievedChunk & {
  provenance: {
    sourceType: string;
    documentId: string;
    chunkId: string;
    scope: string;
  };
}> {
  return chunks.map((chunk) => ({
    ...chunk,
    provenance: {
      sourceType: chunk.sourceType,
      documentId: chunk.documentId,
      chunkId: chunk.chunkId,
      scope: chunk.scope
    }
  }));
}

export function createIngestionRegistry() {
  const markers = new Map<string, IngestionMarker>();

  return {
    register(input: { sourceKey: string; fingerprint: string }) {
      const existing = markers.get(input.sourceKey);
      if (existing && existing.fingerprint === input.fingerprint && !existing.stale) {
        return {
          action: "noop" as const,
          marker: existing
        };
      }

      const marker: IngestionMarker = {
        sourceKey: input.sourceKey,
        fingerprint: input.fingerprint,
        stale: false,
        reason: null
      };
      markers.set(input.sourceKey, marker);

      return {
        action: "ingest" as const,
        marker
      };
    },
    markFailed(input: { sourceKey: string; fingerprint: string; reason: string }) {
      const existing = markers.get(input.sourceKey);
      if (!existing || existing.fingerprint !== input.fingerprint) {
        return;
      }

      markers.set(input.sourceKey, {
        ...existing,
        stale: true,
        reason: input.reason
      });
    },
    get(sourceKey: string) {
      return markers.get(sourceKey) ?? null;
    }
  };
}

function fuseCandidates(lexical: RetrievedChunk[], vector: RetrievedChunk[]): HybridCandidate[] {
  const fused = new Map<string, HybridCandidate>();

  lexical.forEach((chunk, index) => {
    upsertFusedCandidate(fused, chunk, 1 / (index + 1));
  });
  vector.forEach((chunk, index) => {
    upsertFusedCandidate(fused, chunk, 1 / (index + 1));
  });

  return Array.from(fused.values()).sort((left, right) => right.fusedScore - left.fusedScore);
}

function upsertFusedCandidate(
  fused: Map<string, HybridCandidate>,
  chunk: RetrievedChunk,
  reciprocalRankScore: number
) {
  const existing = fused.get(chunk.chunkId);
  if (existing) {
    existing.fusedScore += reciprocalRankScore;
    return;
  }

  fused.set(chunk.chunkId, {
    ...chunk,
    fusedScore: reciprocalRankScore,
    provenance: {
      sourceType: chunk.sourceType,
      documentId: chunk.documentId,
      chunkId: chunk.chunkId,
      scope: chunk.scope
    }
  });
}

function estimateTokenCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length * 20;
}
