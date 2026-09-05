import type { CursorPage, PageCursor, WorldPatchRequest } from "@covel/shared";
import type {
  MessageRecord,
  SessionRecord,
  StatePatchRecord,
  WorldRecord,
} from "../api.js";

export type WorldPatch = WorldPatchRequest;

export type SessionPatch = Partial<
  Pick<SessionRecord, "status" | "presetId" | "runtimeModelOverrides">
>;

export interface DataService {
  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  createWorld(name: string, description: string): Promise<WorldRecord>;
  saveGeneratedWorld(world: WorldRecord): Promise<WorldRecord>;
  updateWorld(id: string, patch: WorldPatch): Promise<WorldRecord>;
  /** Ensure APIs needed before session creation can resolve this world. */
  prepareWorldForServer(worldId: string): Promise<void>;

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
    updates: SessionPatch,
  ): Promise<SessionRecord>;
  deleteSession(sessionId: string): Promise<void>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  /**
   * Keyset page of messages, oldest-first. `before` omitted ⇒ the newest
   * window; `cursor` set ⇒ the page immediately older than that position
   * (scroll-up "load older"). `nextCursor` is the oldest returned row, or
   * `null` once the start of history is reached. Remote透传后端端点；local 直连
   * IDB 并按契约包成 `{ items, nextCursor }`。
   */
  listMessagesPage(
    sessionId: string,
    opts: { limit?: number; cursor?: PageCursor },
  ): Promise<CursorPage<MessageRecord>>;
  /** Persist a browser-authored input before its action is dispatched. */
  addMessage(msg: MessageRecord): Promise<void>;

  // State patches
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;
  addStatePatch(sessionId: string, patch: StatePatchRecord): Promise<void>;

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
   */
  loadSubmittedBlocks(sessionId: string): Promise<{
    ids: string[];
    values: Record<string, Record<string, unknown>>;
  }>;

  /**
   * Sync session context to server MemoryStore before sending actions.
   * In remote mode this is a no-op. In local mode it pushes
   * the complete browser checkpoint so the transient server can process work.
   */
  syncToServer(sessionId: string): Promise<void>;

  /** Durably remember which server mutation must become the next checkpoint. */
  stageServerCommit(sessionId: string, actionId: string): Promise<void>;

  /** Persist the transient server result as the next browser checkpoint. */
  commitFromServer(sessionId: string, actionId: string): Promise<void>;

  /** Persist accumulated execution timeline steps for a session. */
  saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void>;
  /** Load persisted execution timeline steps for a session. */
  loadExecutionSteps(sessionId: string): Promise<unknown[]>;
}
