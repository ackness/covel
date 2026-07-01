import type { CursorPage } from "@covel/shared";
import type {
  MessageRecord,
  SessionRecord,
  StatePatchRecord,
  WorldRecord,
} from "../api.js";

export type WorldPatch = Partial<
  Pick<
    WorldRecord,
    "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
  >
>;

export interface DataService {
  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  createWorld(name: string, description: string): Promise<WorldRecord>;
  saveGeneratedWorld(world: WorldRecord): Promise<WorldRecord>;
  updateWorld(id: string, patch: WorldPatch): Promise<WorldRecord>;

  // Sessions
  listSessions(worldId: string): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  createSession(
    worldId: string,
    presetId?: string,
    id?: string,
    plugins?: string[],
    locale?: string,
  ): Promise<SessionRecord>;
  updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ): Promise<SessionRecord>;
  deleteSession(sessionId: string): Promise<void>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  /**
   * Keyset page of messages, oldest-first. `before` omitted ⇒ the newest
   * window; `before` set ⇒ the page immediately older than that position
   * (scroll-up "load older"). `nextCursor` is the oldest returned row, or
   * `null` once the start of history is reached. Remote透传后端端点；local 直连
   * IDB 并按契约包成 `{ items, nextCursor }`。
   */
  listMessagesPage(
    sessionId: string,
    opts: { limit?: number; before?: { createdAt: string; id: string } },
  ): Promise<CursorPage<MessageRecord>>;
  addMessage(msg: MessageRecord): Promise<void>;

  // State patches
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;
  addStatePatch(sessionId: string, patch: StatePatchRecord): Promise<void>;

  /**
   * Persist post-commit state snapshot from the kernel.
   * T1/T2 (local): writes to IndexedDB.
   * T3 (remote): no-op (server handles persistence).
   */
  persistStateSnapshot(
    sessionId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Load the most recent state snapshot for a session.
   * Returns null if no snapshot exists (fresh session).
   */
  loadStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null>;

  /**
   * Persist submitted block IDs and their submitted form values for a session.
   * Tracks which interactive blocks have been submitted (locks their UI) and
   * keeps the values around so disabled forms can re-display the input.
   */
  saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
  ): Promise<void>;

  /**
   * Load submitted block IDs + values for a session. Both default to empty.
   * Legacy storage that holds only `string[]` is migrated transparently.
   */
  loadSubmittedBlocks(sessionId: string): Promise<{
    ids: string[];
    values: Record<string, Record<string, unknown>>;
  }>;

  /**
   * Sync session context to server MemoryStore before sending actions.
   * In remote mode this is a no-op. In local mode it pushes
   * world + session + messages so the stateless server can process the turn.
   */
  syncToServer(sessionId: string): Promise<void>;

  /** Persist accumulated execution timeline steps for a session. */
  saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void>;
  /** Load persisted execution timeline steps for a session. */
  loadExecutionSteps(sessionId: string): Promise<unknown[]>;
}
