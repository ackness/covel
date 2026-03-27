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

export interface EntityEdgeCandidate {
  entity: string;
  fromChunkId: string;
  toChunkId: string;
  weight: number;
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

export function buildRetrievedChunksFromDocuments(
  documents: MemoryDocument[]
): RetrievedChunk[] {
  return documents.flatMap((document) =>
    chunkMemoryDocument(document).map((chunk) => ({
      chunkId: chunk.chunkId,
      documentId: document.id,
      scope: document.scope,
      sourceType: document.sourceType,
      text: chunk.text,
      provenance: {
        sourceType: document.sourceType,
        documentId: document.id,
        chunkId: chunk.chunkId,
        scope: document.scope
      }
    }))
  );
}

export function lexicalSearchRetrievedChunks(input: {
  query: string;
  chunks: RetrievedChunk[];
  limit?: number;
}): RetrievedChunk[] {
  const tokens = tokenizeSearchText(input.query);
  if (tokens.length === 0) {
    return [];
  }

  const ranked = input.chunks
    .map((chunk) => {
      const haystack = normalizeSearchText(chunk.text);
      let score = 0;

      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += token.length;
        }
      }

      return score > 0
        ? {
            ...chunk,
            lexicalScore: score
          }
        : null;
    });

  return ranked
    .filter((chunk): chunk is RetrievedChunk & { lexicalScore: number } => chunk !== null)
    .sort((left, right) =>
      (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0) ||
      left.chunkId.localeCompare(right.chunkId)
    )
    .slice(0, input.limit ?? 8);
}

export function buildEntityEdgeCandidates(chunks: RetrievedChunk[]): EntityEdgeCandidate[] {
  const edges: EntityEdgeCandidate[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const left = chunks[index];
    if (!left) {
      continue;
    }

    const leftEntities = extractComparableTerms(left.text);
    for (let inner = index + 1; inner < chunks.length; inner += 1) {
      const right = chunks[inner];
      if (!right) {
        continue;
      }

      const rightEntities = extractComparableTerms(right.text);
      const shared = leftEntities.filter((entity) => rightEntities.includes(entity));
      for (const entity of shared) {
        edges.push({
          entity,
          fromChunkId: left.chunkId,
          toChunkId: right.chunkId,
          weight: entity.length
        });
      }
    }
  }

  return edges;
}

export function expandRetrievedChunksByEntities(input: {
  selected: RetrievedChunk[];
  allChunks: RetrievedChunk[];
  maxAdditional?: number;
}): Array<RetrievedChunk & {
  graphWeight?: number;
}> {
  const selectedIds = new Set(input.selected.map((chunk) => chunk.chunkId));
  const edges = buildEntityEdgeCandidates(input.allChunks);
  const ranked = new Map<string, RetrievedChunk & { graphWeight?: number }>();

  for (const edge of edges) {
    const leftSelected = selectedIds.has(edge.fromChunkId);
    const rightSelected = selectedIds.has(edge.toChunkId);
    if (leftSelected === rightSelected) {
      continue;
    }

    const targetId = leftSelected ? edge.toChunkId : edge.fromChunkId;
    const target = input.allChunks.find((chunk) => chunk.chunkId === targetId);
    if (!target) {
      continue;
    }

    const existing = ranked.get(targetId);
    if (existing) {
      existing.graphWeight = (existing.graphWeight ?? 0) + edge.weight;
      continue;
    }

    ranked.set(targetId, {
      ...target,
      graphWeight: edge.weight
    });
  }

  const selectedDocumentIds = new Set(input.selected.map((chunk) => chunk.documentId));
  for (const chunk of input.allChunks) {
    if (
      selectedIds.has(chunk.chunkId) ||
      !selectedDocumentIds.has(chunk.documentId)
    ) {
      continue;
    }

    const existing = ranked.get(chunk.chunkId);
    if (existing) {
      existing.graphWeight = (existing.graphWeight ?? 0) + 0.5;
      continue;
    }

    ranked.set(chunk.chunkId, {
      ...chunk,
      graphWeight: 0.5
    });
  }

  return Array.from(ranked.values())
    .sort((left, right) =>
      (right.graphWeight ?? 0) - (left.graphWeight ?? 0) ||
      left.chunkId.localeCompare(right.chunkId)
    )
    .slice(0, input.maxAdditional ?? 4);
}

export async function retrieveEntityAware(input: {
  query: string;
  documents: MemoryDocument[];
  vectorSearch?: () => Promise<RetrievedChunk[]>;
  lexicalLimit?: number;
}): Promise<{
  mode: "hybrid" | "fts-only" | "vector-only";
  candidates: HybridCandidate[];
  expanded: Array<RetrievedChunk & { graphWeight?: number }>;
}> {
  const allChunks = buildRetrievedChunksFromDocuments(input.documents);
  const result = await retrieveHybrid({
    query: input.query,
    lexicalSearch: async () => lexicalSearchRetrievedChunks({
      query: input.query,
      chunks: allChunks,
      limit: input.lexicalLimit ?? 2
    }),
    vectorSearch: input.vectorSearch ?? (async () => {
      throw new Error("vector search unavailable");
    })
  });

  const expanded = expandRetrievedChunksByEntities({
    selected: result.candidates,
    allChunks
  });

  return {
    ...result,
    expanded
  };
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

function extractComparableTerms(text: string): string[] {
  const parts = text
    .split(/\n+/)
    .flatMap((line) => line.split(/[，。；：,.!?()[\]【】]/g))
    .map((part) => normalizeSearchText(part))
    .filter((part) => part.length >= 2 && part.length <= 64);
  const tokenHints = parts.flatMap((part) => tokenizeComparablePart(part));

  return Array.from(new Set([...parts, ...tokenHints]));
}

function tokenizeSearchText(text: string): string[] {
  return Array.from(new Set(
    text
      .split(/[\s，。；：,.!?()[\]【】]+/g)
      .map((part) => normalizeSearchText(part))
      .filter((part) => part.length >= 2)
  ));
}

function normalizeSearchText(text: string): string {
  return text.toLowerCase().trim();
}

function tokenizeComparablePart(text: string): string[] {
  const words = text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
  const phrases = [...words];

  for (let index = 0; index < words.length; index += 1) {
    if (index + 1 < words.length) {
      phrases.push(`${words[index]} ${words[index + 1]}`);
    }
    if (index + 2 < words.length) {
      phrases.push(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
    }
  }

  return phrases;
}
