import { createRequire } from "node:module";

import { Pool } from "pg";

import type { DomainRepositories } from "../../domain/src/index.js";

import { createArtifactPathPolicy, type ArtifactPathPolicy } from "./artifact-path-policy.js";
import { createLocalArtifactStore, type LocalArtifactStore } from "./local-artifact-store.js";

type Queryable = {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end?(): Promise<void> | void;
};

export interface PostgresStoragePort {
  kind: "postgres";
  createRepositories(): Promise<DomainRepositories>;
  createArtifactStore(): Promise<LocalArtifactStore>;
}

interface PostgresStoragePortOptions {
  connectionString?: string;
  pool?: Queryable;
  artifactRootDirectory?: string;
  pathPolicy?: ArtifactPathPolicy;
}

const testPoolRegistry = new Map<string, Queryable>();
const require = createRequire(import.meta.url);

export function createPostgresStoragePort(
  options: PostgresStoragePortOptions = {}
): PostgresStoragePort {
  const queryable = options.pool ?? createQueryable(options.connectionString);
  const artifactRootDirectory =
    options.artifactRootDirectory ?? `${process.cwd()}/data/artifacts`;
  const pathPolicy = options.pathPolicy ?? createArtifactPathPolicy();
  let bootstrapPromise: Promise<void> | null = null;

  async function ensureBootstrapped(): Promise<void> {
    if (!bootstrapPromise) {
      bootstrapPromise = bootstrapSchema(queryable);
    }

    return bootstrapPromise;
  }

  return {
    kind: "postgres",
    async createRepositories() {
      await ensureBootstrapped();
      return createRepositories(queryable);
    },
    async createArtifactStore() {
      await ensureBootstrapped();
      return createLocalArtifactStore({
        rootDirectory: artifactRootDirectory,
        pathPolicy
      });
    }
  };
}

function createQueryable(connectionString?: string): Queryable {
  if (!connectionString) {
    throw new Error(
      "Postgres storage adapter requires a connectionString or an injected pool."
    );
  }

  if (process.env.VITEST) {
    const existing = testPoolRegistry.get(connectionString);
    if (existing) {
      return existing;
    }

    const { newDb } = requirePgMem();
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool() as Queryable;
    testPoolRegistry.set(connectionString, pool);
    return pool;
  }

  return new Pool({
    connectionString
  });
}

async function bootstrapSchema(queryable: Queryable): Promise<void> {
  const statements = [
    `create table if not exists worlds (
      id text,
      name text,
      description text,
      created_at text
    )`,
    `create unique index if not exists worlds_id_idx on worlds(id)`,
    `create table if not exists sessions (
      id text,
      world_id text,
      status text,
      created_at text
    )`,
    `create unique index if not exists sessions_id_idx on sessions(id)`,
    `create table if not exists messages (
      id text,
      session_id text,
      role text,
      content text,
      created_at text
    )`,
    `create unique index if not exists messages_id_idx on messages(id)`,
    `create table if not exists artifacts (
      id text,
      session_id text,
      kind text,
      uri text,
      media_type text,
      created_at text
    )`,
    `create unique index if not exists artifacts_id_idx on artifacts(id)`,
    `create table if not exists archive_versions (
      id text,
      session_id text,
      turn_cutoff integer,
      state_snapshot text,
      working_summary text,
      archive_summary text,
      created_at text
    )`,
    `create unique index if not exists archive_versions_id_idx on archive_versions(id)`,
    `create table if not exists memory_documents (
      id text,
      source_type text,
      scope text,
      title text,
      content text,
      metadata_json text,
      provenance_json text
    )`,
    `create unique index if not exists memory_documents_id_idx on memory_documents(id)`,
    `create table if not exists retrieval_runs (
      id text,
      session_id text,
      query text,
      rewritten_queries_json text,
      selected_sources_json text,
      candidates_json text,
      selected_chunks_json text,
      critique text,
      latency_ms integer
    )`,
    `create unique index if not exists retrieval_runs_id_idx on retrieval_runs(id)`,
    `create table if not exists trace_records (
      trace_id text,
      span_id text,
      session_id text,
      turn_id text,
      component text,
      event_type text,
      payload_json text,
      created_at text
    )`,
    `create unique index if not exists trace_records_trace_span_idx on trace_records(trace_id, span_id)`
  ];

  for (const statement of statements) {
    await queryable.query(statement);
  }
}

function createRepositories(queryable: Queryable): DomainRepositories {
  return {
    worlds: {
      async save(world) {
        await queryable.query(
          `insert into worlds (id, name, description, created_at)
           values ($1, $2, $3, $4)
           on conflict (id) do update set
             name = excluded.name,
             description = excluded.description,
             created_at = excluded.created_at`,
          [world.id, world.name, world.description, world.createdAt.toISOString()]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          name: string;
          description: string;
          created_at: string | Date;
        }>("select id, name, description, created_at from worlds where id = $1", [id]);
        const row = result.rows[0];
        return row
          ? {
              id: row.id,
              name: row.name,
              description: row.description,
              createdAt: new Date(row.created_at)
            }
          : null;
      },
      async list() {
        const result = await queryable.query<{
          id: string;
          name: string;
          description: string;
          created_at: string | Date;
        }>("select id, name, description, created_at from worlds order by created_at asc");
        return result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          createdAt: new Date(row.created_at)
        }));
      }
    },
    sessions: {
      async save(session) {
        await queryable.query(
          `insert into sessions (id, world_id, status, created_at)
           values ($1, $2, $3, $4)
           on conflict (id) do update set
             world_id = excluded.world_id,
             status = excluded.status,
             created_at = excluded.created_at`,
          [session.id, session.worldId, session.status, session.createdAt.toISOString()]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          world_id: string;
          status: "active" | "waiting_for_input" | "archived";
          created_at: string | Date;
        }>("select id, world_id, status, created_at from sessions where id = $1", [id]);
        const row = result.rows[0];
        return row
          ? {
              id: row.id,
              worldId: row.world_id,
              status: row.status,
              createdAt: new Date(row.created_at)
            }
          : null;
      },
      async listByWorldId(worldId) {
        const result = await queryable.query<{
          id: string;
          world_id: string;
          status: "active" | "waiting_for_input" | "archived";
          created_at: string | Date;
        }>(
          "select id, world_id, status, created_at from sessions where world_id = $1 order by created_at asc",
          [worldId]
        );
        return result.rows.map((row) => ({
          id: row.id,
          worldId: row.world_id,
          status: row.status,
          createdAt: new Date(row.created_at)
        }));
      }
    },
    messages: {
      async save(message) {
        await queryable.query(
          `insert into messages (id, session_id, role, content, created_at)
           values ($1, $2, $3, $4, $5)
           on conflict (id) do update set
             session_id = excluded.session_id,
             role = excluded.role,
             content = excluded.content,
             created_at = excluded.created_at`,
          [
            message.id,
            message.sessionId,
            message.role,
            message.content,
            message.createdAt.toISOString()
          ]
        );
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          id: string;
          session_id: string;
          role: "system" | "user" | "assistant";
          content: string;
          created_at: string | Date;
        }>(
          "select id, session_id, role, content, created_at from messages where session_id = $1 order by created_at asc",
          [sessionId]
        );
        return result.rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          role: row.role,
          content: row.content,
          createdAt: new Date(row.created_at)
        }));
      }
    },
    artifacts: {
      async save(artifact) {
        await queryable.query(
          `insert into artifacts (id, session_id, kind, uri, media_type, created_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do update set
             session_id = excluded.session_id,
             kind = excluded.kind,
             uri = excluded.uri,
             media_type = excluded.media_type,
             created_at = excluded.created_at`,
          [
            artifact.id,
            artifact.sessionId,
            artifact.kind,
            artifact.uri,
            artifact.mediaType,
            artifact.createdAt.toISOString()
          ]
        );
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          id: string;
          session_id: string;
          kind: string;
          uri: string;
          media_type: string;
          created_at: string | Date;
        }>(
          "select id, session_id, kind, uri, media_type, created_at from artifacts where session_id = $1 order by created_at asc",
          [sessionId]
        );
        return result.rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          kind: row.kind,
          uri: row.uri,
          mediaType: row.media_type,
          createdAt: new Date(row.created_at)
        }));
      }
    },
    archiveVersions: {
      async save(version) {
        await queryable.query(
          `insert into archive_versions (id, session_id, turn_cutoff, state_snapshot, working_summary, archive_summary, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do update set
             session_id = excluded.session_id,
             turn_cutoff = excluded.turn_cutoff,
             state_snapshot = excluded.state_snapshot,
             working_summary = excluded.working_summary,
             archive_summary = excluded.archive_summary,
             created_at = excluded.created_at`,
          [
            version.id,
            version.sessionId,
            version.turnCutoff,
            JSON.stringify(version.stateSnapshot),
            version.workingSummary,
            version.archiveSummary,
            version.createdAt.toISOString()
          ]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          session_id: string;
          turn_cutoff: number;
          state_snapshot: string;
          working_summary: string;
          archive_summary: string;
          created_at: string | Date;
        }>("select * from archive_versions where id = $1", [id]);
        const row = result.rows[0];
        return row ? mapArchiveVersion(row) : null;
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          id: string;
          session_id: string;
          turn_cutoff: number;
          state_snapshot: string;
          working_summary: string;
          archive_summary: string;
          created_at: string | Date;
        }>(
          "select * from archive_versions where session_id = $1 order by created_at asc",
          [sessionId]
        );
        return result.rows.map(mapArchiveVersion);
      }
    },
    memoryDocuments: {
      async save(document) {
        await queryable.query(
          `insert into memory_documents (id, source_type, scope, title, content, metadata_json, provenance_json)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id) do update set
             source_type = excluded.source_type,
             scope = excluded.scope,
             title = excluded.title,
             content = excluded.content,
             metadata_json = excluded.metadata_json,
             provenance_json = excluded.provenance_json`,
          [
            document.id,
            document.sourceType,
            document.scope,
            document.title,
            document.content,
            JSON.stringify(document.metadata),
            JSON.stringify(document.provenance)
          ]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          source_type: string;
          scope: string;
          title: string;
          content: string;
          metadata_json: string;
          provenance_json: string;
        }>("select * from memory_documents where id = $1", [id]);
        const row = result.rows[0];
        return row ? mapMemoryDocument(row) : null;
      },
      async listByScope(scope) {
        const result = await queryable.query<{
          id: string;
          source_type: string;
          scope: string;
          title: string;
          content: string;
          metadata_json: string;
          provenance_json: string;
        }>("select * from memory_documents where scope = $1 order by id asc", [scope]);
        return result.rows.map(mapMemoryDocument);
      }
    },
    retrievalRuns: {
      async save(run) {
        await queryable.query(
          `insert into retrieval_runs (id, session_id, query, rewritten_queries_json, selected_sources_json, candidates_json, selected_chunks_json, critique, latency_ms)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do update set
             session_id = excluded.session_id,
             query = excluded.query,
             rewritten_queries_json = excluded.rewritten_queries_json,
             selected_sources_json = excluded.selected_sources_json,
             candidates_json = excluded.candidates_json,
             selected_chunks_json = excluded.selected_chunks_json,
             critique = excluded.critique,
             latency_ms = excluded.latency_ms`,
          [
            run.id,
            run.sessionId,
            run.query,
            JSON.stringify(run.rewrittenQueries),
            JSON.stringify(run.selectedSources),
            JSON.stringify(run.candidates),
            JSON.stringify(run.selectedChunks),
            run.critique,
            run.latencyMs
          ]
        );
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          id: string;
          session_id: string;
          query: string;
          rewritten_queries_json: string;
          selected_sources_json: string;
          candidates_json: string;
          selected_chunks_json: string;
          critique: string;
          latency_ms: number;
        }>(
          "select * from retrieval_runs where session_id = $1 order by id asc",
          [sessionId]
        );
        return result.rows.map(mapRetrievalRun);
      }
    },
    traceRecords: {
      async save(record) {
        await queryable.query(
          `insert into trace_records (trace_id, span_id, session_id, turn_id, component, event_type, payload_json, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (trace_id, span_id) do update set
             session_id = excluded.session_id,
             turn_id = excluded.turn_id,
             component = excluded.component,
             event_type = excluded.event_type,
             payload_json = excluded.payload_json,
             created_at = excluded.created_at`,
          [
            record.traceId,
            record.spanId,
            record.sessionId,
            record.turnId,
            record.component,
            record.eventType,
            JSON.stringify(record.payload),
            record.createdAt.toISOString()
          ]
        );
      },
      async listByTraceId(traceId) {
        const result = await queryable.query<{
          trace_id: string;
          span_id: string;
          session_id: string;
          turn_id: string;
          component: string;
          event_type: string;
          payload_json: string;
          created_at: string | Date;
        }>(
          "select * from trace_records where trace_id = $1 order by created_at asc",
          [traceId]
        );
        return result.rows.map(mapTraceRecord);
      }
    }
  };
}

function mapArchiveVersion(row: {
  id: string;
  session_id: string;
  turn_cutoff: number;
  state_snapshot: string;
  working_summary: string;
  archive_summary: string;
  created_at: string | Date;
}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnCutoff: row.turn_cutoff,
    stateSnapshot: JSON.parse(row.state_snapshot) as Record<string, unknown>,
    workingSummary: row.working_summary,
    archiveSummary: row.archive_summary,
    createdAt: new Date(row.created_at)
  };
}

function mapMemoryDocument(row: {
  id: string;
  source_type: string;
  scope: string;
  title: string;
  content: string;
  metadata_json: string;
  provenance_json: string;
}) {
  return {
    id: row.id,
    sourceType: row.source_type,
    scope: row.scope,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>
  };
}

function mapRetrievalRun(row: {
  id: string;
  session_id: string;
  query: string;
  rewritten_queries_json: string;
  selected_sources_json: string;
  candidates_json: string;
  selected_chunks_json: string;
  critique: string;
  latency_ms: number;
}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    query: row.query,
    rewrittenQueries: JSON.parse(row.rewritten_queries_json) as string[],
    selectedSources: JSON.parse(row.selected_sources_json) as string[],
    candidates: JSON.parse(row.candidates_json) as string[],
    selectedChunks: JSON.parse(row.selected_chunks_json) as string[],
    critique: row.critique,
    latencyMs: row.latency_ms
  };
}

function mapTraceRecord(row: {
  trace_id: string;
  span_id: string;
  session_id: string;
  turn_id: string;
  component: string;
  event_type: string;
  payload_json: string;
  created_at: string | Date;
}) {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    component: row.component,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: new Date(row.created_at)
  };
}

function requirePgMem(): typeof import("pg-mem") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("pg-mem");
}
