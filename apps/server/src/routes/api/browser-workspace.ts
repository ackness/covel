import { appendDimensionPlan } from "../../world-data/session-import/dimensions.js";
import { applyPreparedWorldDataImportForSession } from "../../world-data/session-import.js";
import { DIMENSION_DATA_NAMESPACE } from "@covel/shared";
import { withMemoryIngestLock } from "../../lib/memory-ingest-lock.js";
import { scheduleMemoryIngest } from "./commit-execution.js";
import {
  isWorldDeleting,
  withoutWorldDeletion,
  worldOperationLockId,
} from "../../world-lifecycle.js";
import { preserveWorldProvenance } from "../../world-seed-loader.js";
import { Hono } from "hono";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeLocale } from "@covel/shared";
import {
  BrowserSyncValidationError,
  RevisionConflictError,
  SessionRecordScopeConflictError,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  validateBrowserCheckpoint,
  type BrowserCheckpoint,
  type DataStore,
  type SessionCommit,
} from "@covel/store/session";
import { errorBody, readJsonBody } from "../../api-error.js";
import {
  publicSessionMetadata,
  resolveSessionParam,
  hasOperatorToken,
  isSessionOwnerAuthEnforced,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";
import { withLockedSessionMutation } from "./session/locked-mutation.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

interface WorkspaceHead {
  readonly incarnation: string;
  revision: number;
  actionId: string;
  readonly commits: Map<string, SessionCommit>;
  checkpoint: BrowserCheckpoint;
}

function hasDurableJobs(checkpoint: BrowserCheckpoint): boolean {
  return checkpoint.pluginData.some((row) => row.namespace === "_runtime_jobs");
}

/** Local authors may append inputs, edit their world, and change session settings. */
function supportsBrowserDelta(
  previous: BrowserCheckpoint,
  incoming: BrowserCheckpoint,
): boolean {
  const executionContent = (checkpoint: BrowserCheckpoint) => {
    const {
      world: _world,
      messages: _messages,
      revision: _revision,
      actionId: _actionId,
      committedAt: _committedAt,
      session,
      ...domains
    } = checkpoint;
    const {
      status: _status,
      runtimeModelOverrides: _overrides,
      updatedAt: _updatedAt,
      ...sessionIdentity
    } = session;
    return { ...domains, session: sessionIdentity };
  };
  if (
    !isDeepStrictEqual(executionContent(previous), executionContent(incoming))
  )
    return false;
  const incomingMessages = new Map(
    incoming.messages.map((row) => [row.id, row]),
  );
  if (
    previous.messages.some(
      (row) => !isDeepStrictEqual(row, incomingMessages.get(row.id)),
    )
  )
    return false;
  const existingIds = new Set(previous.messages.map((row) => row.id));
  return incoming.messages.every(
    (row) => existingIds.has(row.id) || row.role === "user",
  );
}

/** One API instance's replay state, released with the session lifecycle. */
export function createBrowserWorkspaceCache() {
  const heads = new Map<string, WorkspaceHead>();
  return {
    get(sessionId: string, incarnation: string): WorkspaceHead | undefined {
      const head = heads.get(sessionId);
      if (head && head.incarnation !== incarnation) {
        heads.delete(sessionId);
        return undefined;
      }
      return head;
    },
    set(sessionId: string, head: WorkspaceHead): void {
      heads.set(sessionId, head);
    },
    clearSession(sessionId: string): void {
      heads.delete(sessionId);
    },
  };
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
export function createBrowserWorkspaceRoutes(
  cache = createBrowserWorkspaceCache(),
): Hono<Env> {
  const routes = new Hono<Env>();

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

    return withLockedSessionMutation({
      c,
      store: c.get("store"),
      sessionLock: c.get("sessionLock"),
      sessionId,
      expectedSession: guard.session,
      allowedStatuses: "any",
      mutate: async (live) => {
        const worldIds = [
          ...new Set(
            [live.worldId, checkpoint.session.worldId].filter(
              (id): id is string => id !== undefined,
            ),
          ),
        ].sort();
        return c
          .get("sessionLock")
          .withLocks(worldIds.map(worldOperationLockId), async () => {
            const worlds = new Map(
              await Promise.all(
                worldIds.map(
                  async (id) =>
                    [id, await c.get("store").getWorld(id)] as const,
                ),
              ),
            );
            if (
              [...worlds.values()].some(
                (world) => world && isWorldDeleting(world),
              )
            ) {
              return c.json(
                errorBody("World deletion is in progress; retry deletion", {
                  code: "world_deleting",
                }),
                409,
              );
            }
            const incarnation = sessionIncarnationIdentity(live);
            const head = cache.get(sessionId, incarnation);
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
                  errorBody(
                    "Browser checkpoint revision already has another head",
                    {
                      code: "revision_conflict",
                      details: {
                        expectedActionId: head.actionId,
                        actualActionId: checkpoint.actionId,
                      },
                    },
                  ),
                  409,
                );
              }
            }

            const writeWorld =
              !isSessionOwnerAuthEnforced(c) || hasOperatorToken(c);
            if (checkpoint.session.worldId && !writeWorld) {
              const world = worlds.get(checkpoint.session.worldId);
              // Ordinary session sync uses the server's existing catalog record.
              // Seed timestamps and derived metadata may change across restarts.
              if (!world) {
                return c.json(
                  errorBody("Operator token required to write a global world", {
                    code: "operator_token_required",
                  }),
                  401,
                );
              }
            }
            if (
              checkpoint.session.worldId &&
              !worlds.get(checkpoint.session.worldId) &&
              !checkpoint.world
            ) {
              return c.json(
                errorBody("World not found", { code: "world_not_found" }),
                404,
              );
            }
            const admittedCheckpoint = {
              ...checkpoint,
              world: checkpoint.world
                ? preserveWorldProvenance(
                    {
                      ...checkpoint.world,
                      metadata: withoutWorldDeletion(checkpoint.world.metadata),
                    },
                    worlds.get(checkpoint.world.id) ?? undefined,
                  )
                : null,
            };
            if (
              head &&
              (hasDurableJobs(checkpoint) ||
                (
                  await c.get("store").listPluginDataSessionScope(sessionId)
                ).some((row) => row.namespace === "_runtime_jobs"))
            ) {
              if (!supportsBrowserDelta(head.checkpoint, checkpoint)) {
                return c.json(
                  errorBody(
                    "Unsupported browser mutation while detached jobs exist",
                    {
                      code: "unsupported_browser_mutation",
                    },
                  ),
                  409,
                );
              }
              // Keep job leases, progress and domain results in place. Replacing
              // a snapshot would rewind a worker that completed after download.
              const admitted = await c
                .get("store")
                .withTransaction(async (tx) => {
                  const existingMessages = new Map(
                    (await tx.listMessages(sessionId)).map((row) => [
                      row.id,
                      row,
                    ]),
                  );
                  const baselineIds = new Set(
                    head.checkpoint.messages.map((row) => row.id),
                  );
                  if (
                    checkpoint.messages.some((row) => {
                      const existing = existingMessages.get(row.id);
                      return (
                        !baselineIds.has(row.id) &&
                        existing &&
                        (existing.role !== row.role ||
                          existing.content !== row.content)
                      );
                    })
                  )
                    return false;
                  for (const row of checkpoint.messages) {
                    if (!existingMessages.has(row.id)) await tx.addMessage(row);
                  }
                  await tx.updateSession(sessionId, {
                    status: checkpoint.session.status,
                    runtimeModelOverrides:
                      checkpoint.session.runtimeModelOverrides,
                    updatedAt: checkpoint.session.updatedAt,
                  });
                  if (writeWorld && admittedCheckpoint.world)
                    await tx.upsertWorld(admittedCheckpoint.world);
                  return true;
                });
              if (!admitted)
                return c.json(
                  errorBody(
                    "Browser input conflicts with a committed message",
                    {
                      code: "unsupported_browser_mutation",
                    },
                  ),
                  409,
                );
              const unchanged = head.revision === checkpoint.revision;
              head.revision = checkpoint.revision;
              head.actionId = checkpoint.actionId;
              head.checkpoint = checkpoint;
              scheduleMemoryIngest(c.get("memorySystem"), sessionId);
              // A lost response can retry this same head, then download the
              // same staged commit without reapplying the input delta.
              return c.json({
                ok: true,
                revision: head.revision,
                unchanged,
                reconcileRequired: true,
              });
            }
            if (head?.revision === checkpoint.revision) {
              return c.json({
                ok: true,
                revision: head.revision,
                unchanged: true,
              });
            }
            try {
              await withMemoryIngestLock(c, sessionId, () =>
                replaceSessionFromCheckpoint(
                  c.get("store"),
                  admittedCheckpoint,
                  {
                    afterRestoreInTx: async (tx) => {
                      if (
                        checkpoint.session.phase !== "setup" ||
                        checkpoint.session.completedPlayerTurns !== 0 ||
                        checkpoint.pluginData.some(
                          (row) => row.namespace === DIMENSION_DATA_NAMESPACE,
                        ) ||
                        checkpoint.worldDataLedger.some(
                          (row) => row.namespace === DIMENSION_DATA_NAMESPACE,
                        )
                      )
                        return;
                      const world = checkpoint.session.worldId
                        ? await tx.getWorld(checkpoint.session.worldId)
                        : null;
                      if (!world?.metadata?.dimensions) return;
                      const plan = appendDimensionPlan(
                        {
                          writes: [],
                          diagnostics: [],
                          mergeEvents: [],
                          deferredProjectionOutputs: [],
                        },
                        world.metadata.dimensions,
                        {
                          registry: c.get("pluginRegistry"),
                          activePlugins: checkpoint.session.activePlugins,
                        },
                        checkpoint.session.locale,
                      );
                      await applyPreparedWorldDataImportForSession({
                        store: tx,
                        sessionId,
                        worldId: world.id,
                        now: checkpoint.committedAt,
                        prepared: {
                          imported: true,
                          diagnostics: [],
                          mediaRefs: [],
                          plan,
                        },
                      });
                    },
                    writeWorld,
                    session: {
                      ...checkpoint.session,
                      createdAt: live.createdAt,
                      phase: checkpoint.session.phase,
                      completedPlayerTurns:
                        checkpoint.session.completedPlayerTurns,
                      setupRuntimes: checkpoint.session.setupRuntimes,
                      metadata: {
                        ...publicSessionMetadata(checkpoint.session.metadata),
                        ...live.metadata,
                      },
                    },
                  },
                ),
              );
            } catch (error) {
              if (error instanceof SessionRecordScopeConflictError) {
                return c.json(
                  errorBody(error.message, { code: error.code }),
                  400,
                );
              }
              throw error;
            }
            c.get("pluginRegistry")?.syncSessionActivations(
              sessionId,
              checkpoint.session.activePlugins,
            );
            c.get("uiSlots")?.clearSession(sessionId);
            c.get("uiSlots")?.invalidateSession(sessionId);
            cache.set(sessionId, {
              incarnation,
              revision: checkpoint.revision,
              actionId: checkpoint.actionId,
              commits: new Map(),
              checkpoint,
            });
            scheduleMemoryIngest(c.get("memorySystem"), sessionId);
            return c.json({ ok: true, revision: checkpoint.revision });
          });
      },
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
    return withLockedSessionMutation({
      c,
      store: c.get("store"),
      sessionLock: c.get("sessionLock"),
      sessionId,
      expectedSession: guard.session,
      allowedStatuses: "any",
      mutate: async (live) => {
        const head = cache.get(sessionId, sessionIncarnationIdentity(live));
        if (!head) {
          return c.json(
            errorBody(
              "Upload a browser checkpoint before requesting a commit",
              {
                code: "browser_checkpoint_required",
              },
            ),
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
          head.checkpoint = checkpoint;
          cacheCommit(head, commit);
          return c.json(commit);
        } catch (error) {
          if (error instanceof BrowserSyncValidationError) {
            return c.json(errorBody(error.message, { code: error.code }), 500);
          }
          throw error;
        }
      },
    });
  });

  return routes;
}
