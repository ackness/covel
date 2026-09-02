import { Hono } from "hono";
import { canonicalizeLocale } from "@covel/shared";
import {
  BrowserSyncValidationError,
  RevisionConflictError,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  validateBrowserCheckpoint,
  type BrowserCheckpoint,
  type DataStore,
  type SessionCommit,
} from "@covel/store";
import { errorBody, readJsonBody } from "../../api-error.js";
import {
  publicSessionMetadata,
  resolveSessionParam,
} from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

interface WorkspaceHead {
  revision: number;
  actionId: string;
  readonly commits: Map<string, SessionCommit>;
}

function canonicalizeCheckpointLocales(
  checkpoint: BrowserCheckpoint,
): BrowserCheckpoint | undefined {
  const sessionLocale = canonicalizeLocale(checkpoint.session.locale);
  if (!sessionLocale) return undefined;

  const snapshots: BrowserCheckpoint["snapshots"][number][] = [];
  for (const snapshot of checkpoint.snapshots) {
    const locale = canonicalizeLocale(snapshot.payload.session.locale);
    if (!locale) return undefined;
    snapshots.push({
      ...snapshot,
      payload: {
        ...snapshot.payload,
        session: { ...snapshot.payload.session, locale },
      },
    });
  }

  return {
    ...checkpoint,
    session: { ...checkpoint.session, locale: sessionLocale },
    snapshots,
  };
}

const MAX_CACHED_ACTIONS = 16;

function browserPrivateOnly(c: {
  get(name: "storeBackend"): string | undefined;
  json: (body: unknown, status: 409) => Response;
}): Response | undefined {
  if (c.get("storeBackend") === "memory") return undefined;
  return c.json(
    errorBody(
      "Browser checkpoints are only available with the browser-private MemoryStore profile",
      { code: "browser_private_profile_required" },
    ),
    409,
  );
}

function cacheCommit(head: WorkspaceHead, commit: SessionCommit): void {
  head.commits.set(commit.actionId, commit);
  while (head.commits.size > MAX_CACHED_ACTIONS) {
    const oldest = head.commits.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    head.commits.delete(oldest);
  }
}

/**
 * Browser-private checkpoint exchange.
 *
 * The server keeps only an ephemeral MemoryStore execution mirror. The
 * browser uploads its latest checkpoint before a turn and atomically applies
 * the returned commit after the SSE stream closes.
 */
export function createBrowserWorkspaceRoutes(): Hono<Env> {
  const routes = new Hono<Env>();
  const heads = new Map<string, WorkspaceHead>();

  routes.put("/:id/browser-checkpoint", async (c) => {
    const wrongProfile = browserPrivateOnly(c);
    if (wrongProfile) return wrongProfile;
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const parsed = await readJsonBody<{ checkpoint?: unknown }>(c);
    if (parsed instanceof Response) return parsed;

    let checkpoint;
    try {
      const validated = validateBrowserCheckpoint(parsed.body.checkpoint);
      checkpoint = canonicalizeCheckpointLocales(validated);
      if (!checkpoint) {
        throw new BrowserSyncValidationError(
          "checkpoint session locale must be a valid BCP 47 locale",
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid browser checkpoint";
      return c.json(errorBody(message, { code: "invalid_checkpoint" }), 400);
    }
    const sessionId = c.req.param("id");
    if (
      checkpoint.sessionId !== sessionId ||
      checkpoint.profile !== "browser-private"
    ) {
      return c.json(
        errorBody("Checkpoint session/profile does not match this route", {
          code: "invalid_checkpoint_scope",
        }),
        400,
      );
    }

    return c.get("sessionLock").withLock(sessionId, async () => {
      const head = heads.get(sessionId);
      if (head && checkpoint.revision < head.revision) {
        return c.json(
          errorBody("Browser checkpoint revision is stale", {
            code: "revision_conflict",
            details: {
              expectedRevision: head.revision,
              actualRevision: checkpoint.revision,
            },
          }),
          409,
        );
      }
      if (head?.revision === checkpoint.revision) {
        if (head.actionId !== checkpoint.actionId) {
          return c.json(
            errorBody("Browser checkpoint revision already has another head", {
              code: "revision_conflict",
              details: {
                expectedActionId: head.actionId,
                actualActionId: checkpoint.actionId,
              },
            }),
            409,
          );
        }
        return c.json({ ok: true, revision: head.revision, unchanged: true });
      }

      const live = await c.get("store").getSession(sessionId);
      if (!live) {
        return c.json(errorBody(`Session not found: ${sessionId}`), 404);
      }
      await replaceSessionFromCheckpoint(c.get("store"), checkpoint, {
        session: {
          ...checkpoint.session,
          phase: checkpoint.session.phase,
          completedPlayerTurns: checkpoint.session.completedPlayerTurns,
          setupRuntimes: checkpoint.session.setupRuntimes,
          metadata: {
            ...checkpoint.session.metadata,
            ...live.metadata,
          },
        },
      });
      heads.set(sessionId, {
        revision: checkpoint.revision,
        actionId: checkpoint.actionId,
        commits: new Map(),
      });
      return c.json({ ok: true, revision: checkpoint.revision });
    });
  });

  routes.post("/:id/browser-commit", async (c) => {
    const wrongProfile = browserPrivateOnly(c);
    if (wrongProfile) return wrongProfile;
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const parsed = await readJsonBody<{
      actionId?: unknown;
      baseRevision?: unknown;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const { actionId, baseRevision } = parsed.body;
    if (
      typeof actionId !== "string" ||
      actionId.length === 0 ||
      !Number.isSafeInteger(baseRevision) ||
      (baseRevision as number) < 0
    ) {
      return c.json(
        errorBody("Expected non-empty actionId and non-negative baseRevision"),
        400,
      );
    }

    const sessionId = c.req.param("id");
    return c.get("sessionLock").withLock(sessionId, async () => {
      const head = heads.get(sessionId);
      if (!head) {
        return c.json(
          errorBody("Upload a browser checkpoint before requesting a commit", {
            code: "browser_checkpoint_required",
          }),
          409,
        );
      }
      const cached = head.commits.get(actionId);
      if (cached) return c.json(cached);
      if (head.revision !== baseRevision) {
        const conflict = new RevisionConflictError(
          sessionId,
          head.revision,
          baseRevision as number,
        );
        return c.json(
          errorBody(conflict.message, {
            code: conflict.code,
            details: {
              expectedRevision: conflict.expectedRevision,
              actualRevision: conflict.actualRevision,
            },
          }),
          409,
        );
      }

      try {
        const revision = head.revision + 1;
        const rawCheckpoint = await exportSessionCheckpoint(
          c.get("store"),
          sessionId,
          { revision, actionId },
        );
        const checkpoint = validateBrowserCheckpoint({
          ...rawCheckpoint,
          session: {
            ...rawCheckpoint.session,
            metadata: publicSessionMetadata(rawCheckpoint.session.metadata),
          },
        });
        const commit: SessionCommit = {
          baseRevision: head.revision,
          revision,
          actionId,
          checkpoint,
        };
        head.revision = revision;
        head.actionId = actionId;
        cacheCommit(head, commit);
        return c.json(commit);
      } catch (error) {
        if (error instanceof BrowserSyncValidationError) {
          return c.json(errorBody(error.message, { code: error.code }), 500);
        }
        throw error;
      }
    });
  });

  return routes;
}
