import { createServer, type Server, type IncomingMessage } from "node:http";

import { ActionRequestSchema, type SseEnvelope } from "../../../modules/contracts/src/index.js";
import { createSession, createWorld, type DomainRepositories } from "../../../modules/domain/src/index.js";
import type { PersistedPresetMetadata, PersistedPresetRecord } from "../../../modules/storage/src/index.js";
import { createRuntimeErrorPayload, resolveRequestLocale } from "./locale.js";

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody.length === 0 ? {} : JSON.parse(rawBody);
}

export function createRuntimeServer(dependencies: {
  flowEngine: {
    handle(action: ReturnType<typeof ActionRequestSchema.parse>): Promise<SseEnvelope[]>;
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
}): Server {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://runtime.local");

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
        const body = (await readRequestBody(request)) as {
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
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
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
        const body = (await readRequestBody(request)) as {
          worldId?: string;
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
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
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

    if (request.method === "GET" && requestUrl.pathname === "/packages") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify(dependencies.packageRuntime?.listPackages() ?? []));
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
        const body = (await readRequestBody(request)) as Partial<PersistedPresetRecord>;
        const updated = await presetMetadataStore.patch(presetId, body);
        response.writeHead(200, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(updated));
      } catch (error) {
        const locale = resolveRequestLocale({
          header: request.headers["accept-language"]
        });
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
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
        const body = (await readRequestBody(request)) as {
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
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
      }
      return;
    }

    if (request.method === "POST" && /^\/archives\/[^/]+\/restore$/.test(requestUrl.pathname)) {
      try {
        const archiveService = requireArchiveService(dependencies.archiveService);
        const archiveVersionId = requestUrl.pathname.split("/")[2] ?? "";
        const body = (await readRequestBody(request)) as {
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
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/actions") {
      try {
        const body = await readRequestBody(request);
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
        response.writeHead(400, {
          "content-type": "application/json"
        });
        response.end(JSON.stringify(createRuntimeErrorPayload("INVALID_REQUEST", locale)));
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
  return dependencies.createId ? dependencies.createId(kind) : `${kind}_${Date.now()}`;
}

function now(
  dependencies: {
    now?(): Date;
  }
): Date {
  return dependencies.now ? dependencies.now() : new Date();
}
