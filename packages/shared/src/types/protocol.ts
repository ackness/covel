/**
 * Covel Session Protocol — transport-agnostic command/event definitions.
 *
 * Inspired by: LSP (JSON-RPC + capability negotiation), LangGraph Agent Protocol
 * (Thread/Run/Store), A2A (Task lifecycle), Colyseus (reconnection + delta sync).
 *
 * Commands flow client → server. Events flow server → client.
 * Both are transport-agnostic — SSE, WebSocket, stdio, HTTP polling all work.
 */

// ── Client Capabilities (negotiated at connection) ──────────────

export interface ClientCapabilities {
  /** Supports streaming narrative deltas (token-by-token). */
  readonly streaming: boolean;
  /** Supports rich interactive blocks (forms, choices, confirmations). */
  readonly richBlocks: boolean;
  /** Supports markdown rendering. */
  readonly markdown: boolean;
  /** Supports image display. */
  readonly images: boolean;
}

export interface ServerCapabilities {
  /** Protocol version (semver). */
  readonly protocolVersion: string;
  /** Available event types. */
  readonly eventTypes: readonly string[];
  /** Supported command types. */
  readonly commandTypes: readonly string[];
}

// ── Commands (client → server) ──────────────────────────────────

export type CommandType =
  | "session.create"
  | "session.restore"
  | "session.fork"
  | "session.get"
  | "session.snapshot"
  | "turn.submit"
  | "turn.retry"
  | "input.submit"
  | "messages.list"
  | "characters.list"
  | "state.get"
  | "trace.list"
  | "plugin-data.get";

export interface SessionCommand {
  readonly id: string;
  readonly type: CommandType;
  readonly sessionId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── Command Payloads ────────────────────────────────────────────

export interface SessionCreatePayload {
  readonly worldId: string;
  readonly locale?: string;
  readonly plugins?: readonly string[];
}

export interface SessionRestorePayload {
  readonly sessionId: string;
  readonly lastEventId?: string;
}

export interface TurnSubmitPayload {
  readonly sessionId: string;
  readonly playerMessage: string;
  readonly locale?: string;
}

export interface InputSubmitPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly interactionId: string;
  readonly type: "form" | "choice" | "confirmation";
  readonly values: Readonly<Record<string, unknown>>;
}

// ── Event Types (server → client) ───────────────────────────────

export type ProtocolEventType =
  // Narrative
  | "narrative.delta"
  | "narrative.completed"
  // Interaction
  | "interaction.requested"
  | "interaction.completed"
  // UI render parts
  | "ui.rendered"
  | "ui.part.update"
  // State
  | "state.changed"
  | "state.snapshot"
  // Execution lifecycle
  | "execution.started"
  | "runtime.started"
  | "runtime.completed"
  | "runtime.failed"
  | "execution.completed"
  // Asset lifecycle
  | "asset.progress"
  | "asset.generated"
  // Session lifecycle
  | "record.updated"
  | "event.emitted"
  // World
  | "world.dimensions.changed"
  // Plugin data
  | "plugin-data.changed"
  // System
  | "error.occurred"
  | "connection.restored"
  // Suspend / Resume (S4-T4)
  | "turn.suspended"
  | "turn.resumed"
  // Snapshot / Fork (S4-T2 / S4-T5)
  | "state.snapshot.created"
  | "session.forked";

export interface ProtocolEvent {
  readonly id: string;
  readonly type: ProtocolEventType;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly source?: { readonly pluginId: string; readonly runtimeId: string };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── Session Snapshot (for restore/reconnection) ─────────────────

export interface SessionSnapshot {
  readonly session: {
    readonly id: string;
    readonly worldId?: string;
    readonly phase: string;
    readonly turnCount: number;
    readonly locale?: string;
  };
  readonly messages: readonly SnapshotMessage[];
  readonly characters: readonly SnapshotCharacter[];
  readonly gameState: Readonly<Record<string, unknown>>;
  readonly executionSteps: readonly SnapshotTraceEvent[];
  readonly plugins: readonly SnapshotPluginStatus[];
  /** Character attribute schema from world-data-provider plugin (if available). */
  readonly characterSchema?: Readonly<Record<string, unknown>>;
}

export interface SnapshotMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly kind?: string;
  readonly block?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface SnapshotCharacter {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface SnapshotTraceEvent {
  readonly type: string;
  readonly turnId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface SnapshotPluginStatus {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly priority: number;
}

// ── Transport Interface ─────────────────────────────────────────

/**
 * Transport-agnostic interface for session communication.
 *
 * Implementations: SSETransport, WebSocketTransport, StdioTransport, HTTPTransport.
 * Each transport handles the wire protocol details; the session logic
 * only interacts through this interface.
 */
export interface SessionTransport {
  /** Send a single event to the connected client. */
  sendEvent(event: ProtocolEvent): Promise<void>;
  /** Register handler for incoming commands. */
  onCommand(handler: (cmd: SessionCommand) => Promise<unknown>): void;
  /** Connection lifecycle. */
  onConnect?(handler: (info: ClientInfo) => void): void;
  onDisconnect?(handler: () => void): void;
}

export interface ClientInfo {
  readonly clientType: "web" | "tui" | "api" | "ws";
  readonly capabilities: ClientCapabilities;
  readonly lastEventId?: string;
}
