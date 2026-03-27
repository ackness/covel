import { createRequire } from "node:module";

import { Pool } from "pg";

import {
  STORY_NARRATION_TASK,
  type DomainRepositories,
  type JobRecord,
  type PackageStateRecord,
  type TaskBindings
} from "../../domain/src/index.js";
import type { WorkflowSnapshotRecord } from "../../contracts/src/index.js";

import { createArtifactPathPolicy, type ArtifactPathPolicy } from "./artifact-path-policy.js";
import { createLocalArtifactStore, type LocalArtifactStore } from "./local-artifact-store.js";
import type {
  PersistedPendingBlockRecord,
  StorageRepositoriesWithPendingBlocks
} from "./pending-block-store.js";
import type { StorageRepositoriesWithPackageStateAndJobs } from "./package-state-store.js";
import type {
  PersistedPresetRecord,
  StorageRepositoriesWithPresets
} from "./preset-metadata-store.js";
import { stripPresetSecrets } from "./preset-metadata-store.js";
import type { StorageRepositoriesWithWorkflowSnapshots } from "./workflow-snapshot-store.js";

type Queryable = {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end?(): Promise<void> | void;
};

export interface PostgresStoragePort {
  kind: "postgres";
  createRepositories(): Promise<
    DomainRepositories &
    StorageRepositoriesWithPresets &
    StorageRepositoriesWithPendingBlocks &
    StorageRepositoriesWithPackageStateAndJobs &
    StorageRepositoriesWithWorkflowSnapshots
  >;
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
      preset_id text,
      task_bindings_json text,
      created_at text
    )`,
    `alter table sessions add column if not exists preset_id text`,
    `alter table sessions add column if not exists task_bindings_json text`,
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
    `create unique index if not exists trace_records_trace_span_idx on trace_records(trace_id, span_id)`,
    `create table if not exists package_state (
      scope text,
      owner_id text,
      package_name text,
      collection_name text,
      record_key text,
      value_json text,
      updated_at text
    )`,
    `create unique index if not exists package_state_scope_owner_pkg_collection_key_idx
      on package_state(scope, owner_id, package_name, collection_name, record_key)`,
    `create table if not exists jobs (
      id text,
      package_name text,
      job_type text,
      session_id text,
      status text,
      input_json text,
      output_json text,
      error text,
      attempt integer,
      created_at text,
      started_at text,
      completed_at text
    )`,
    `create unique index if not exists jobs_id_idx on jobs(id)`,
    `create table if not exists workflow_snapshots (
      run_id text,
      step_id text,
      session_id text,
      status text,
      suspend_payload_json text,
      resume_data_json text,
      updated_at text
    )`,
    `create unique index if not exists workflow_snapshots_run_id_idx on workflow_snapshots(run_id)`,
    `create table if not exists preset_metadata (
      id text,
      name text,
      provider text,
      model text,
      tier text,
      base_url text,
      fallback_preset_ids_json text,
      supported_modes_json text,
      enabled boolean,
      is_default boolean,
      scope text,
      api_key text
    )`,
    `alter table preset_metadata add column if not exists fallback_preset_ids_json text`,
    `create unique index if not exists preset_metadata_id_idx on preset_metadata(id)`,
    `create table if not exists pending_blocks (
      block_id text,
      session_id text,
      flow_id text,
      turn_id text,
      block_envelope_json text,
      package_name text,
      resume_handler text
    )`,
    `alter table pending_blocks add column if not exists block_envelope_json text`,
    `alter table pending_blocks add column if not exists package_name text`,
    `alter table pending_blocks add column if not exists resume_handler text`,
    `create unique index if not exists pending_blocks_block_id_idx on pending_blocks(block_id)`
  ];

  for (const statement of statements) {
    await queryable.query(statement);
  }
}

function createRepositories(queryable: Queryable): DomainRepositories &
  StorageRepositoriesWithPresets &
  StorageRepositoriesWithPendingBlocks &
  StorageRepositoriesWithPackageStateAndJobs &
  StorageRepositoriesWithWorkflowSnapshots {
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
          `insert into sessions (id, world_id, status, preset_id, task_bindings_json, created_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do update set
             world_id = excluded.world_id,
             status = excluded.status,
             preset_id = excluded.preset_id,
             task_bindings_json = excluded.task_bindings_json,
             created_at = excluded.created_at`,
          [
            session.id,
            session.worldId,
            session.status,
            resolveNarrationPresetId(session.taskBindings, session.presetId) ?? null,
            JSON.stringify(resolveStoredTaskBindings(session.taskBindings, session.presetId)),
            session.createdAt.toISOString()
          ]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          world_id: string;
          status: "active" | "waiting_for_input" | "archived";
          preset_id: string | null;
          task_bindings_json: string | null;
          created_at: string | Date;
        }>("select id, world_id, status, preset_id, task_bindings_json, created_at from sessions where id = $1", [id]);
        const row = result.rows[0];
        const taskBindings = parseTaskBindings(row?.task_bindings_json, row?.preset_id ?? undefined);
        return row
          ? {
              id: row.id,
              worldId: row.world_id,
              status: row.status,
              ...(resolveNarrationPresetId(taskBindings, row.preset_id ?? undefined)
                ? { presetId: resolveNarrationPresetId(taskBindings, row.preset_id ?? undefined) }
                : {}),
              ...(taskBindings ? { taskBindings } : {}),
              createdAt: new Date(row.created_at)
            }
          : null;
      },
      async listByWorldId(worldId) {
        const result = await queryable.query<{
          id: string;
          world_id: string;
          status: "active" | "waiting_for_input" | "archived";
          preset_id: string | null;
          task_bindings_json: string | null;
          created_at: string | Date;
        }>(
          "select id, world_id, status, preset_id, task_bindings_json, created_at from sessions where world_id = $1 order by created_at asc",
          [worldId]
        );
        return result.rows.map((row) => {
          const taskBindings = parseTaskBindings(row.task_bindings_json, row.preset_id ?? undefined);
          return {
            id: row.id,
            worldId: row.world_id,
            status: row.status,
            ...(resolveNarrationPresetId(taskBindings, row.preset_id ?? undefined)
              ? { presetId: resolveNarrationPresetId(taskBindings, row.preset_id ?? undefined) }
              : {}),
            ...(taskBindings ? { taskBindings } : {}),
            createdAt: new Date(row.created_at)
          };
        });
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
    },
    packageState: {
      async save(record) {
        await queryable.query(
          `insert into package_state (scope, owner_id, package_name, collection_name, record_key, value_json, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (scope, owner_id, package_name, collection_name, record_key) do update set
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
          [
            record.scope,
            record.ownerId,
            record.packageName,
            record.collection,
            record.key,
            JSON.stringify(record.value),
            record.updatedAt.toISOString()
          ]
        );
      },
      async get(input) {
        const result = await queryable.query<{
          scope: PackageStateRecord["scope"];
          owner_id: string;
          package_name: string;
          collection_name: string;
          record_key: string;
          value_json: string;
          updated_at: string | Date;
        }>(
          `select * from package_state
           where scope = $1 and owner_id = $2 and package_name = $3 and collection_name = $4 and record_key = $5`,
          [input.scope, input.ownerId, input.packageName, input.collection, input.key]
        );
        const row = result.rows[0];
        return row ? mapPackageStateRecord(row) : null;
      },
      async listByCollection(input) {
        const result = await queryable.query<{
          scope: PackageStateRecord["scope"];
          owner_id: string;
          package_name: string;
          collection_name: string;
          record_key: string;
          value_json: string;
          updated_at: string | Date;
        }>(
          `select * from package_state
           where scope = $1 and owner_id = $2 and package_name = $3 and collection_name = $4
           order by record_key asc`,
          [input.scope, input.ownerId, input.packageName, input.collection]
        );
        return result.rows.map(mapPackageStateRecord);
      }
    },
    jobs: {
      async save(record) {
        await queryable.query(
          `insert into jobs (id, package_name, job_type, session_id, status, input_json, output_json, error, attempt, created_at, started_at, completed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (id) do update set
             package_name = excluded.package_name,
             job_type = excluded.job_type,
             session_id = excluded.session_id,
             status = excluded.status,
             input_json = excluded.input_json,
             output_json = excluded.output_json,
             error = excluded.error,
             attempt = excluded.attempt,
             created_at = excluded.created_at,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at`,
          [
            record.id,
            record.packageName,
            record.jobType,
            record.sessionId ?? null,
            record.status,
            JSON.stringify(record.input),
            record.output ? JSON.stringify(record.output) : null,
            record.error ?? null,
            record.attempt,
            record.createdAt.toISOString(),
            record.startedAt?.toISOString() ?? null,
            record.completedAt?.toISOString() ?? null
          ]
        );
      },
      async getById(id) {
        const result = await queryable.query<{
          id: string;
          package_name: string;
          job_type: string;
          session_id: string | null;
          status: JobRecord["status"];
          input_json: string;
          output_json: string | null;
          error: string | null;
          attempt: number;
          created_at: string | Date;
          started_at: string | Date | null;
          completed_at: string | Date | null;
        }>("select * from jobs where id = $1", [id]);
        const row = result.rows[0];
        return row ? mapJobRecord(row) : null;
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          id: string;
          package_name: string;
          job_type: string;
          session_id: string | null;
          status: JobRecord["status"];
          input_json: string;
          output_json: string | null;
          error: string | null;
          attempt: number;
          created_at: string | Date;
          started_at: string | Date | null;
          completed_at: string | Date | null;
        }>("select * from jobs where session_id = $1 order by created_at asc", [sessionId]);
        return result.rows.map(mapJobRecord);
      },
      async listByStatus(status) {
        const result = await queryable.query<{
          id: string;
          package_name: string;
          job_type: string;
          session_id: string | null;
          status: JobRecord["status"];
          input_json: string;
          output_json: string | null;
          error: string | null;
          attempt: number;
          created_at: string | Date;
          started_at: string | Date | null;
          completed_at: string | Date | null;
        }>("select * from jobs where status = $1 order by created_at asc", [status]);
        return result.rows.map(mapJobRecord);
      }
    },
    workflowSnapshots: {
      async save(record) {
        await queryable.query(
          `insert into workflow_snapshots (run_id, step_id, session_id, status, suspend_payload_json, resume_data_json, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (run_id) do update set
             step_id = excluded.step_id,
             session_id = excluded.session_id,
             status = excluded.status,
             suspend_payload_json = excluded.suspend_payload_json,
             resume_data_json = excluded.resume_data_json,
             updated_at = excluded.updated_at`,
          [
            record.runId,
            record.stepId,
            record.sessionId,
            record.status,
            record.suspendPayload ? JSON.stringify(record.suspendPayload) : null,
            record.resumeData ? JSON.stringify(record.resumeData) : null,
            record.updatedAt
          ]
        );
      },
      async getByRunId(runId) {
        const result = await queryable.query<{
          run_id: string;
          step_id: string;
          session_id: string;
          status: WorkflowSnapshotRecord["status"];
          suspend_payload_json: string | null;
          resume_data_json: string | null;
          updated_at: string;
        }>("select * from workflow_snapshots where run_id = $1", [runId]);
        const row = result.rows[0];
        return row ? mapWorkflowSnapshotRecord(row) : null;
      },
      async listBySessionId(sessionId) {
        const result = await queryable.query<{
          run_id: string;
          step_id: string;
          session_id: string;
          status: WorkflowSnapshotRecord["status"];
          suspend_payload_json: string | null;
          resume_data_json: string | null;
          updated_at: string;
        }>(
          "select * from workflow_snapshots where session_id = $1 order by updated_at asc",
          [sessionId]
        );
        return result.rows.map(mapWorkflowSnapshotRecord);
      }
    },
    pendingBlocks: {
      async save(input: PersistedPendingBlockRecord) {
        await queryable.query(
          `insert into pending_blocks (block_id, session_id, flow_id, turn_id, block_envelope_json, package_name, resume_handler)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (block_id) do update set
             session_id = excluded.session_id,
             flow_id = excluded.flow_id,
             turn_id = excluded.turn_id,
             block_envelope_json = excluded.block_envelope_json,
             package_name = excluded.package_name,
             resume_handler = excluded.resume_handler`,
          [
            input.blockId,
            input.sessionId,
            input.flowId,
            input.turnId,
            input.blockEnvelope ? JSON.stringify(input.blockEnvelope) : null,
            input.packageName ?? null,
            input.resumeHandler ?? null
          ]
        );
      },
      async getByBlockId(blockId: string) {
        const result = await queryable.query<{
          block_id: string;
          session_id: string;
          flow_id: string;
          turn_id: string;
          block_envelope_json: string | null;
          package_name: string | null;
          resume_handler: string | null;
        }>("select * from pending_blocks where block_id = $1", [blockId]);
        const row = result.rows[0];
        return row
          ? {
              blockId: row.block_id,
              sessionId: row.session_id,
              flowId: row.flow_id,
              turnId: row.turn_id,
              ...(row.block_envelope_json
                ? { blockEnvelope: JSON.parse(row.block_envelope_json) as Record<string, unknown> }
                : {}),
              ...(row.package_name ? { packageName: row.package_name } : {}),
              ...(row.resume_handler ? { resumeHandler: row.resume_handler } : {})
            }
          : null;
      },
      async delete(blockId: string) {
        await queryable.query("delete from pending_blocks where block_id = $1", [blockId]);
      }
    },
    presets: {
      async save(input: PersistedPresetRecord) {
        await queryable.query(
          `insert into preset_metadata (id, name, provider, model, tier, base_url, fallback_preset_ids_json, supported_modes_json, enabled, is_default, scope, api_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict (id) do update set
             name = excluded.name,
             provider = excluded.provider,
             model = excluded.model,
             tier = excluded.tier,
             base_url = excluded.base_url,
             fallback_preset_ids_json = excluded.fallback_preset_ids_json,
             supported_modes_json = excluded.supported_modes_json,
             enabled = excluded.enabled,
             is_default = excluded.is_default,
             scope = excluded.scope,
             api_key = excluded.api_key`,
          [
            input.id,
            input.name,
            input.provider,
            input.model,
            input.tier,
            input.baseUrl,
            JSON.stringify(input.fallbackPresetIds ?? []),
            JSON.stringify(input.supportedModes),
            input.enabled,
            input.isDefault,
            input.scope,
            input.apiKey ?? null
          ]
        );
      },
      async patch(
        presetId: string,
        input: Partial<PersistedPresetRecord>
      ) {
        const existing = await readPersistedPresetRecordById(queryable, presetId);
        const next: PersistedPresetRecord = {
          ...(existing ?? {
            id: presetId,
            name: presetId,
            provider: "openaiCompatible",
            model: "",
            tier: "medium",
            baseUrl: "",
            supportedModes: ["text", "object", "stream"],
            enabled: true,
            isDefault: false,
            scope: "global"
          }),
          ...input,
          id: presetId
        } as PersistedPresetRecord;
        await this.save(next);
        return stripPresetSecrets(next);
      },
      async getById(id: string) {
        const result = await queryable.query<{
          id: string;
          name: string;
          provider: string;
          model: string;
          tier: "small" | "medium" | "large";
          base_url: string;
          fallback_preset_ids_json: string | null;
          supported_modes_json: string;
          enabled: boolean;
          is_default: boolean;
          scope: string;
          api_key: string | null;
        }>("select * from preset_metadata where id = $1", [id]);
        const row = result.rows[0];
        return row
          ? stripPresetSecrets({
              id: row.id,
              name: row.name,
              provider: row.provider,
              model: row.model,
              tier: row.tier,
              baseUrl: row.base_url,
              ...(parseFallbackPresetIds(row.fallback_preset_ids_json)
                ? { fallbackPresetIds: parseFallbackPresetIds(row.fallback_preset_ids_json) }
                : {}),
              supportedModes: JSON.parse(row.supported_modes_json) as Array<"text" | "object" | "stream">,
              enabled: row.enabled,
              isDefault: row.is_default,
              scope: row.scope,
              apiKey: row.api_key ?? undefined
            })
          : null;
      },
      async list() {
        const result = await queryable.query<{
          id: string;
          name: string;
          provider: string;
          model: string;
          tier: "small" | "medium" | "large";
          base_url: string;
          fallback_preset_ids_json: string | null;
          supported_modes_json: string;
          enabled: boolean;
          is_default: boolean;
          scope: string;
          api_key: string | null;
        }>("select * from preset_metadata order by id asc");
        return result.rows.map((row) =>
          stripPresetSecrets({
            id: row.id,
            name: row.name,
            provider: row.provider,
            model: row.model,
            tier: row.tier,
            baseUrl: row.base_url,
            ...(parseFallbackPresetIds(row.fallback_preset_ids_json)
              ? { fallbackPresetIds: parseFallbackPresetIds(row.fallback_preset_ids_json) }
              : {}),
            supportedModes: JSON.parse(row.supported_modes_json) as Array<"text" | "object" | "stream">,
            enabled: row.enabled,
            isDefault: row.is_default,
            scope: row.scope,
            apiKey: row.api_key ?? undefined
          })
        );
      }
    }
  };
}

async function readPersistedPresetRecordById(
  queryable: Queryable,
  id: string
): Promise<PersistedPresetRecord | null> {
  const result = await queryable.query<{
    id: string;
    name: string;
    provider: string;
    model: string;
    tier: "small" | "medium" | "large";
    base_url: string;
    fallback_preset_ids_json: string | null;
    supported_modes_json: string;
    enabled: boolean;
    is_default: boolean;
    scope: string;
    api_key: string | null;
  }>("select * from preset_metadata where id = $1", [id]);
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        name: row.name,
        provider: row.provider,
        model: row.model,
        tier: row.tier,
        baseUrl: row.base_url,
        ...(parseFallbackPresetIds(row.fallback_preset_ids_json)
          ? { fallbackPresetIds: parseFallbackPresetIds(row.fallback_preset_ids_json) }
          : {}),
        supportedModes: JSON.parse(row.supported_modes_json) as Array<"text" | "object" | "stream">,
        enabled: row.enabled,
        isDefault: row.is_default,
        scope: row.scope,
        apiKey: row.api_key ?? undefined
      }
    : null;
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

function parseFallbackPresetIds(value: string | null | undefined): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const fallbackPresetIds = parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return fallbackPresetIds.length > 0 ? fallbackPresetIds : undefined;
}

function resolveStoredTaskBindings(taskBindings: TaskBindings | undefined, presetId: string | undefined): TaskBindings {
  const nextTaskBindings = {
    ...(taskBindings ?? {})
  };

  if (typeof presetId === "string" && presetId.length > 0 && !nextTaskBindings[STORY_NARRATION_TASK]) {
    nextTaskBindings[STORY_NARRATION_TASK] = presetId;
  }

  return nextTaskBindings;
}

function parseTaskBindings(value: string | null | undefined, presetId: string | undefined): TaskBindings | undefined {
  const parsed = typeof value === "string" && value.length > 0 ? JSON.parse(value) as unknown : {};
  const taskBindings: TaskBindings = {};

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [task, preset] of Object.entries(parsed)) {
      if (typeof task === "string" && task.length > 0 && typeof preset === "string" && preset.length > 0) {
        taskBindings[task] = preset;
      }
    }
  }

  if (typeof presetId === "string" && presetId.length > 0 && !taskBindings[STORY_NARRATION_TASK]) {
    taskBindings[STORY_NARRATION_TASK] = presetId;
  }

  return Object.keys(taskBindings).length > 0 ? taskBindings : undefined;
}

function resolveNarrationPresetId(taskBindings: TaskBindings | undefined, presetId: string | undefined): string | undefined {
  return taskBindings?.[STORY_NARRATION_TASK] ?? presetId;
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

function mapPackageStateRecord(row: {
  scope: PackageStateRecord["scope"];
  owner_id: string;
  package_name: string;
  collection_name: string;
  record_key: string;
  value_json: string;
  updated_at: string | Date;
}): PackageStateRecord {
  return {
    scope: row.scope,
    ownerId: row.owner_id,
    packageName: row.package_name,
    collection: row.collection_name,
    key: row.record_key,
    value: JSON.parse(row.value_json) as Record<string, unknown>,
    updatedAt: new Date(row.updated_at)
  };
}

function mapJobRecord(row: {
  id: string;
  package_name: string;
  job_type: string;
  session_id: string | null;
  status: JobRecord["status"];
  input_json: string;
  output_json: string | null;
  error: string | null;
  attempt: number;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
}): JobRecord {
  return {
    id: row.id,
    packageName: row.package_name,
    jobType: row.job_type,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    status: row.status,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    ...(row.output_json ? { output: JSON.parse(row.output_json) as Record<string, unknown> } : {}),
    ...(row.error ? { error: row.error } : {}),
    attempt: row.attempt,
    createdAt: new Date(row.created_at),
    ...(row.started_at ? { startedAt: new Date(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {})
  };
}

function mapWorkflowSnapshotRecord(row: {
  run_id: string;
  step_id: string;
  session_id: string;
  status: WorkflowSnapshotRecord["status"];
  suspend_payload_json: string | null;
  resume_data_json: string | null;
  updated_at: string;
}): WorkflowSnapshotRecord {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    sessionId: row.session_id,
    status: row.status,
    ...(row.suspend_payload_json
      ? { suspendPayload: JSON.parse(row.suspend_payload_json) as Record<string, unknown> }
      : {}),
    ...(row.resume_data_json
      ? { resumeData: JSON.parse(row.resume_data_json) as Record<string, unknown> }
      : {}),
    updatedAt: row.updated_at
  };
}

function requirePgMem(): typeof import("pg-mem") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("pg-mem");
}
