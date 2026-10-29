import { vi } from "vitest";
import {
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  type BrowserCheckpoint,
  type SessionCommit,
} from "@covel/store/browser-sync";
import { ApiError } from "../../api/request.js";
import type { SessionRecord } from "../../api.js";
import type { BrowserVault } from "../../storage/browser-vault.js";

export interface ServerSessionSeed {
  readonly sessionId: string;
  readonly worldId: string;
  readonly activePlugins?: string[];
  readonly excludedPlugins?: string[];
  readonly locale?: string;
  readonly loreOverride?: string;
  readonly session?: Partial<BrowserCheckpoint["session"]>;
}

/** A fresh server session's export before any player turn: revision 0. */
export function serverInitialCheckpoint(
  seed: ServerSessionSeed,
  createdAt = "2026-09-01T00:00:00.000Z",
): BrowserCheckpoint {
  const activePlugins = seed.activePlugins ?? [];
  return {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId: seed.sessionId,
    profile: "browser-private",
    session: {
      id: seed.sessionId,
      worldId: seed.worldId,
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      locale: seed.locale ?? "en",
      activePlugins,
      metadata: {
        ...(seed.loreOverride !== undefined
          ? { loreOverride: seed.loreOverride }
          : {}),
        pluginSelection: {
          requested: activePlugins,
          excluded: seed.excludedPlugins ?? [],
        },
      },
      createdAt,
      updatedAt: createdAt,
      ...seed.session,
    },
    world: null,
    messages: [],
    turnMessages: [],
    turnResults: [],
    toolCalls: [],
    runtimeOutputs: [],
    interactions: [],
    events: [],
    traceEvents: [],
    characters: [],
    characterSchema: null,
    pluginData: [],
    lorebookEntries: [],
    sessionSummaries: [],
    playerInputs: [],
    suspensions: [],
    snapshots: [],
    worldDataLedger: [],
    logicalTurnLedger: [],
    setupAttempts: [],
    jobStatus: [],
    runtimeExports: [],
    revision: 0,
    actionId: "server:create",
    committedAt: createdAt,
  };
}

type CreateSessionArgs = [
  worldId: string,
  id?: string,
  plugins?: string[],
  locale?: string,
  loreOverride?: string,
  excludedPlugins?: string[],
];

export interface FakeSessionServerOptions {
  /** The browser vault whose latest save later commits echo. */
  readonly vault?: () => BrowserVault;
  /** Server-side changes to a created session, such as resolved dependencies. */
  readonly initialize?: (
    seed: ServerSessionSeed,
  ) => Partial<BrowserCheckpoint["session"]> | undefined;
  /** Server-side changes to every later commit. */
  readonly patch?: (
    checkpoint: BrowserCheckpoint,
  ) => Partial<BrowserCheckpoint> | undefined;
}

/**
 * The browser-private server as LocalDataService sees it, shaped as a mock of
 * `services/api.js`. Creating a session records its initialization and the
 * first commit exports it. Later commits echo the browser's latest save (plus
 * `patch`), like an action that wrote nothing new.
 */
export function fakeSessionServer(options: FakeSessionServerOptions = {}) {
  const created = new Map<string, BrowserCheckpoint>();
  return {
    created,
    getWorld: vi.fn(async (id: string) => ({ id })),
    createWorld: vi.fn(async (world: { id: string }) => world),
    updateWorld: vi.fn(async (id: string) => ({ id })),
    deleteSession: vi.fn(async (sessionId: string) => {
      created.delete(sessionId);
    }),
    createSession: vi.fn(
      async (
        ...[
          worldId,
          id,
          plugins,
          locale,
          loreOverride,
          excluded,
        ]: CreateSessionArgs
      ): Promise<SessionRecord> => {
        if (!id) throw new Error("the browser always names its session");
        const seed: ServerSessionSeed = {
          sessionId: id,
          worldId,
          activePlugins: plugins,
          excludedPlugins: excluded,
          locale,
          loreOverride,
        };
        const checkpoint = serverInitialCheckpoint({
          ...seed,
          session: options.initialize?.(seed),
        });
        created.set(id, checkpoint);
        const { metadata: _metadata, ...session } = checkpoint.session;
        return { ...session, worldId } as SessionRecord;
      },
    ),
    fetchBrowserCommit: vi.fn(
      async (
        sessionId: string,
        actionId: string,
        baseRevision: number,
      ): Promise<SessionCommit> => {
        const base =
          baseRevision === 0
            ? created.get(sessionId)
            : await options.vault?.().getLatestCheckpoint(sessionId);
        if (!base) {
          throw new ApiError(
            409,
            "/browser-commit",
            JSON.stringify({
              error: "Upload a browser checkpoint first",
              code: "browser_checkpoint_required",
            }),
          );
        }
        const revision = baseRevision + 1;
        const checkpoint = { ...base, revision, actionId };
        return {
          baseRevision,
          revision,
          actionId,
          checkpoint: { ...checkpoint, ...options.patch?.(checkpoint) },
        };
      },
    ),
  };
}
