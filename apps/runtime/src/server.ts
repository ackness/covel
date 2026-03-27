import { randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";

import {
  ActionRequestSchema,
  type SseEnvelope,
  type WorkflowSnapshotRecord
} from "../../../modules/contracts/src/index.js";
import { STORY_NARRATION_TASK, createSession, createWorld, type DomainRepositories, type TaskBindings } from "../../../modules/domain/src/index.js";
import type { PersistedPresetMetadata, PersistedPresetRecord } from "../../../modules/storage/src/index.js";
import { createRuntimeErrorPayload, resolveRequestLocale } from "./locale.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RuntimeRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function readRequestBody(
  request: IncomingMessage,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxRequestBodyBytes) {
      throw new RuntimeRequestError("PAYLOAD_TOO_LARGE");
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody.length === 0 ? {} : JSON.parse(rawBody);
}

export function createRuntimeServer(dependencies: {
  flowEngine: {
    handle(action: ReturnType<typeof ActionRequestSchema.parse>): Promise<SseEnvelope[]>;
  };
  commandRegistry?: {
    listHelp(): Array<{
      name: string;
      description: string;
      usage: string;
      examples?: string[];
    }>;
    listAutocomplete(): Array<{
      name: string;
      positionalHints?: string[];
      flagHints?: Array<{
        name: string;
        description: string;
        takesValue: boolean;
      }>;
    }>;
  };
  repositories?: DomainRepositories;
  packageRuntime?: {
    listPackages(): unknown[];
  };
  presetMetadataStore?: {
    list(): Promise<PersistedPresetMetadata[]>;
    patch(
      presetId: string,
      input: Partial<PersistedPresetRecord>
    ): Promise<PersistedPresetMetadata>;
  };
  archiveService?: {
    createSnapshot(input: {
      sessionId: string;
      turnCutoff: number;
      stateSnapshot: Record<string, unknown>;
      workingSummary: string;
      archiveSummary: string;
    }): Promise<unknown>;
    restoreInPlace(input: { archiveVersionId: string }): Promise<unknown>;
    restoreAsFork(input: { archiveVersionId: string }): Promise<unknown>;
  };
  createId?(kind: string): string;
  now?(): Date;
  maxRequestBodyBytes?: number;
}): Server {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://runtime.local");
    const readJsonBody = () => readRequestBody(request, dependencies.maxRequestBodyBytes);

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/worlds") {
      const repositories = requireRepositories(dependencies.repositories);
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(await repositories.worlds.list()));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/worlds") {
      try {
        const repositories = requireRepositories(dependencies.repositories);
        const body = (await readJsonBody()) as {
          name?: string;
          description?: string;
          locale?: string;
        };
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: body.locale
        });
        const world = createWorld({
          id: createId(dependencies, "world"),
          name: String(body.name ?? ""),
          description: String(body.description ?? ""),
          createdAt: now(dependencies)
        });
        await repositories.worlds.save(world);
        response.writeHead(201, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(world));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/sessions") {
      const repositories = requireRepositories(dependencies.repositories);
      const worldId = requestUrl.searchParams.get("worldId");
      const sessions = worldId
        ? await repositories.sessions.listByWorldId(worldId)
        : [];
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(sessions));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/sessions") {
      try {
        const repositories = requireRepositories(dependencies.repositories);
        const body = (await readJsonBody()) as {
          worldId?: string;
          presetId?: string;
          taskBindings?: Record<string, unknown>;
          locale?: string;
        };
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: body.locale
        });
        const session = createSession({
          id: createId(dependencies, "session"),
          worldId: String(body.worldId ?? ""),
          status: "active",
          ...normalizeSessionBindingInput(body),
          createdAt: now(dependencies)
        });
        await repositories.sessions.save(session);
        response.writeHead(201, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(session));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if ((request.method === "PUT" || request.method === "PATCH") && /^\/sessions\/[^/]+$/.test(requestUrl.pathname)) {
      try {
        const repositories = requireRepositories(dependencies.repositories);
        const sessionId = requestUrl.pathname.split("/")[2] ?? "";
        const existing = await repositories.sessions.getById(sessionId);
        if (!existing) {
          response.writeHead(404, {
            "content-type": "application/json"
          });
          response.end(JSON.stringify(createRuntimeErrorPayload("NOT_FOUND", resolveRequestLocale({
            header: request.headers["accept-language"]
          }))));
          return;
        }

        const body = (await readJsonBody()) as {
          presetId?: string | null;
          taskBindings?: Record<string, unknown> | null;
        };
        const nextSession = createSession({
          ...existing,
          ...normalizeSessionBindingInput(body, existing)
        });
        await repositories.sessions.save(nextSession);
        response.writeHead(200, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(nextSession));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/sessions/") && requestUrl.pathname.endsWith("/messages")) {
      const repositories = requireRepositories(dependencies.repositories);
      const sessionId = requestUrl.pathname.split("/")[2];
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(await repositories.messages.listBySessionId(sessionId)));
      return;
    }

    if (request.method === "GET" && /^\/sessions\/[^/]+\/workflow-snapshots$/.test(requestUrl.pathname)) {
      const repositories = requireRepositoriesWithWorkflowSnapshots(dependencies.repositories);
      const sessionId = requestUrl.pathname.split("/")[2] ?? "";
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(await repositories.workflowSnapshots.listBySessionId(sessionId)));
      return;
    }

    if (request.method === "GET" && /^\/sessions\/[^/]+\/package-state$/.test(requestUrl.pathname)) {
      const repositories = requireRepositoriesWithPackageState(dependencies.repositories);
      const sessionId = requestUrl.pathname.split("/")[2] ?? "";
      const packageName = requestUrl.searchParams.get("packageName");
      const collection = requestUrl.searchParams.get("collection");
      const records =
        packageName && collection
          ? await repositories.packageState.listByCollection({
              scope: "session",
              ownerId: sessionId,
              packageName,
              collection
            })
          : [];
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(records));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/packages") {
      const packages = (dependencies.packageRuntime?.listPackages() ?? []) as Array<{
        name?: unknown;
        enabled?: unknown;
      }>;
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(
        packages.map((pkg) => ({
          name: String(pkg.name ?? ""),
          enabled: Boolean(pkg.enabled)
        }))
      ));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/commands") {
      const helpEntries = dependencies.commandRegistry?.listHelp() ?? [];
      const autocompleteEntries = new Map(
        (dependencies.commandRegistry?.listAutocomplete() ?? []).map((entry) => [entry.name, entry] as const)
      );
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(
        helpEntries.map((entry) => ({
          ...entry,
          ...(autocompleteEntries.get(entry.name)?.positionalHints
            ? { positionalHints: autocompleteEntries.get(entry.name)?.positionalHints }
            : {}),
          ...(autocompleteEntries.get(entry.name)?.flagHints
            ? { flagHints: autocompleteEntries.get(entry.name)?.flagHints }
            : {})
        }))
      ));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/presets") {
      const presetMetadataStore = requirePresetMetadataStore(dependencies.presetMetadataStore);
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(await presetMetadataStore.list()));
      return;
    }

    if ((request.method === "PUT" || request.method === "PATCH") && /^\/presets\/[^/]+$/.test(requestUrl.pathname)) {
      try {
        const presetMetadataStore = requirePresetMetadataStore(dependencies.presetMetadataStore);
        const presetId = requestUrl.pathname.split("/")[2] ?? "";
        const body = (await readJsonBody()) as Partial<PersistedPresetRecord>;
        const updated = await presetMetadataStore.patch(presetId, sanitizePresetPatch(body));
        response.writeHead(200, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(updated));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/archives") {
      const repositories = requireRepositories(dependencies.repositories);
      const sessionId = requestUrl.searchParams.get("sessionId");
      const versions = sessionId
        ? await repositories.archiveVersions.listBySessionId(sessionId)
        : [];
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(versions));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/traces") {
      const repositories = requireRepositories(dependencies.repositories);
      const traceId = requestUrl.searchParams.get("traceId");
      const entries = traceId
        ? await repositories.traceRecords.listByTraceId(traceId)
        : [];
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(entries));
      return;
    }

    if (request.method === "GET" && /^\/traces\/[^/]+$/.test(requestUrl.pathname)) {
      const repositories = requireRepositories(dependencies.repositories);
      const traceId = requestUrl.pathname.split("/")[2] ?? "";
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(await repositories.traceRecords.listByTraceId(traceId)));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/archives") {
      try {
        const archiveService = requireArchiveService(dependencies.archiveService);
        const body = (await readJsonBody()) as {
          sessionId?: string;
          turnCutoff?: number;
          stateSnapshot?: Record<string, unknown>;
          workingSummary?: string;
          archiveSummary?: string;
          locale?: string;
        };
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: body.locale
        });
        const snapshot = await archiveService.createSnapshot({
          sessionId: String(body.sessionId ?? ""),
          turnCutoff: Number(body.turnCutoff ?? 0),
          stateSnapshot: body.stateSnapshot ?? {},
          workingSummary: String(body.workingSummary ?? ""),
          archiveSummary: String(body.archiveSummary ?? "")
        });
        response.writeHead(201, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(snapshot));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if (request.method === "POST" && /^\/archives\/[^/]+\/restore$/.test(requestUrl.pathname)) {
      try {
        const archiveService = requireArchiveService(dependencies.archiveService);
        const archiveVersionId = requestUrl.pathname.split("/")[2] ?? "";
        const body = (await readJsonBody()) as {
          mode?: string;
          locale?: string;
        };
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: body.locale
        });
        const result =
          body.mode === "restore-as-fork"
            ? await archiveService.restoreAsFork({ archiveVersionId })
            : await archiveService.restoreInPlace({ archiveVersionId });
        response.writeHead(200, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(result));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/actions") {
      try {
        const body = await readJsonBody();
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: (body as { locale?: string } | null | undefined)?.locale
        });
        const action = ActionRequestSchema.parse({
          ...(body as Record<string, unknown>),
          locale
        });
        const events = await dependencies.flowEngine.handle(action);

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });

        for (const event of events) {
          response.write(`id: ${event.seq}\n`);
          response.write(`event: ${event.type}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        response.end();
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"],
          bodyLocale: undefined
        });
        response.writeHead(resolveRuntimeErrorStatus(error), {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload(resolveRuntimeErrorCode(error), locale)));
      }
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(createRuntimeErrorPayload("NOT_FOUND", resolveRequestLocale({
      header: request.headers["accept-language"]
    }))));
  });
}

function requireRepositories(repositories: DomainRepositories | undefined): DomainRepositories {
  if (!repositories) {
    throw new Error("Runtime repositories are not configured.");
  }

  return repositories;
}

function requireRepositoriesWithPackageState(
  repositories: DomainRepositories | undefined
): DomainRepositories & {
  packageState: {
    listByCollection(input: {
      scope: "world" | "session";
      ownerId: string;
      packageName: string;
      collection: string;
    }): Promise<unknown[]>;
  };
} {
  const resolved = requireRepositories(repositories) as DomainRepositories & {
    packageState?: {
      listByCollection(input: {
        scope: "world" | "session";
        ownerId: string;
        packageName: string;
        collection: string;
      }): Promise<unknown[]>;
    };
  };
  if (!resolved.packageState) {
    throw new Error("Runtime package state store is not configured.");
  }
  return resolved as DomainRepositories & {
    packageState: {
      listByCollection(input: {
        scope: "world" | "session";
        ownerId: string;
        packageName: string;
        collection: string;
      }): Promise<unknown[]>;
    };
  };
}

function requireRepositoriesWithWorkflowSnapshots(
  repositories: DomainRepositories | undefined
): DomainRepositories & {
  workflowSnapshots: {
    listBySessionId(sessionId: string): Promise<WorkflowSnapshotRecord[]>;
  };
} {
  const resolved = requireRepositories(repositories) as DomainRepositories & {
    workflowSnapshots?: {
      listBySessionId(sessionId: string): Promise<WorkflowSnapshotRecord[]>;
    };
  };
  if (!resolved.workflowSnapshots) {
    throw new Error("Runtime workflow snapshot store is not configured.");
  }
  return resolved as DomainRepositories & {
    workflowSnapshots: {
      listBySessionId(sessionId: string): Promise<WorkflowSnapshotRecord[]>;
    };
  };
}

function requirePresetMetadataStore(
  presetMetadataStore:
    | {
        list(): Promise<PersistedPresetMetadata[]>;
        patch(
          presetId: string,
          input: Partial<PersistedPresetRecord>
        ): Promise<PersistedPresetMetadata>;
      }
    | undefined
) {
  if (!presetMetadataStore) {
    throw new Error("Runtime preset metadata store is not configured.");
  }

  return presetMetadataStore;
}

function requireArchiveService(
  archiveService: {
    createSnapshot(input: {
      sessionId: string;
      turnCutoff: number;
      stateSnapshot: Record<string, unknown>;
      workingSummary: string;
      archiveSummary: string;
    }): Promise<unknown>;
    restoreInPlace(input: { archiveVersionId: string }): Promise<unknown>;
    restoreAsFork(input: { archiveVersionId: string }): Promise<unknown>;
  } | undefined
) {
  if (!archiveService) {
    throw new Error("Runtime archive service is not configured.");
  }

  return archiveService;
}

function createId(
  dependencies: {
    createId?(kind: string): string;
  },
  kind: string
): string {
  return dependencies.createId ? dependencies.createId(kind) : `${kind}_${randomUUID()}`;
}

function now(
  dependencies: {
    now?(): Date;
  }
): Date {
  return dependencies.now ? dependencies.now() : new Date();
}

function sanitizePresetPatch(input: Partial<PersistedPresetRecord>): Partial<PersistedPresetRecord> {
  const patch: Partial<PersistedPresetRecord> = {};

  if (typeof input.name === "string") {
    patch.name = input.name;
  }
  if (typeof input.model === "string") {
    patch.model = input.model;
  }
  if (typeof input.enabled === "boolean") {
    patch.enabled = input.enabled;
  }
  if (typeof input.isDefault === "boolean") {
    patch.isDefault = input.isDefault;
  }
  if (
    Array.isArray(input.fallbackPresetIds) &&
    input.fallbackPresetIds.every((presetId) => typeof presetId === "string" && presetId.trim().length > 0)
  ) {
    patch.fallbackPresetIds = input.fallbackPresetIds.map((presetId) => presetId.trim());
  }

  return patch;
}

function normalizeSessionBindingInput(
  input: {
    presetId?: string | null;
    taskBindings?: Record<string, unknown> | null;
  },
  existing?: {
    presetId?: string;
    taskBindings?: TaskBindings;
  }
): {
  presetId?: string;
  taskBindings?: TaskBindings;
} {
  const hasExplicitTaskBindings = input.taskBindings !== undefined;
  let nextTaskBindings = hasExplicitTaskBindings
    ? sanitizeTaskBindings(input.taskBindings)
    : existing?.taskBindings
      ? { ...existing.taskBindings }
      : undefined;

  if (typeof input.presetId === "string" && input.presetId.trim().length > 0) {
    nextTaskBindings = {
      ...(nextTaskBindings ?? {}),
      [STORY_NARRATION_TASK]: input.presetId.trim()
    };
  } else if (input.presetId === null && nextTaskBindings) {
    const { [STORY_NARRATION_TASK]: _removed, ...rest } = nextTaskBindings;
    nextTaskBindings = Object.keys(rest).length > 0 ? rest : undefined;
  }

  const presetId = nextTaskBindings?.[STORY_NARRATION_TASK];
  return {
    ...(presetId ? { presetId } : {}),
    ...(nextTaskBindings ? { taskBindings: nextTaskBindings } : {})
  };
}

function sanitizeTaskBindings(input: Record<string, unknown> | null | undefined): TaskBindings | undefined {
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const taskBindings = Object.fromEntries(
    Object.entries(input)
      .filter(([task, presetId]) => typeof task === "string" && task.trim().length > 0 && typeof presetId === "string" && presetId.trim().length > 0)
      .map(([task, presetId]) => [task.trim(), (presetId as string).trim()])
  );

  return Object.keys(taskBindings).length > 0 ? taskBindings : undefined;
}

function resolveRuntimeErrorCode(error: unknown): string {
  if (error instanceof RuntimeRequestError) {
    return error.code;
  }

  return "INVALID_REQUEST";
}

function resolveRuntimeErrorStatus(error: unknown): number {
  return error instanceof RuntimeRequestError && error.code === "PAYLOAD_TOO_LARGE"
    ? 413
    : 400;
}
