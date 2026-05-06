/**
 * InteractionRecord — unified translation-layer record for one external input.
 *
 * Paired with `RuntimeOutput`: RuntimeOutput captures "what a runtime produced",
 * InteractionRecord captures "what came in from outside" (player message, plugin
 * UI click, form submit, RPC call, external-agent skill invocation).
 *
 * Both feed the same observability pipeline and can be merged into a single
 * chronological event stream on the consumer side.
 */

// ── Enums ─────────────────────────────────────────────────────────

/** Who originated the interaction. */
export type InteractionSource =
	| "player" // Human player via any UI
	| "plugin-ui" // A plugin's own UI widget (auto-fired, not direct player intent)
	| "external-api"; // External automation / third-party integration

/** Which transport carried the interaction. */
export type InteractionChannel =
	| "web" // Browser frontend
	| "cli" // Terminal clients
	| "api" // Raw HTTP API consumer
	| "external"; // Third-party agent (Codex, Claude Code, etc.)

/** The kind of interaction. Distinct from InteractionType in execution.ts. */
export type InteractionRecordType =
	| "message" // Free-text player input
	| "click" // Plugin UI button / choice click
	| "form-submit" // Structured form submission
	| "rpc-call" // Plugin RPC invocation (PR-3)
	| "skill-invoke"; // External agent invoked a Covel skill

// ── Top-level record ──────────────────────────────────────────────

export interface InteractionRecordMetaData {
	/** Front-end state snapshot at click time (e.g. which choice was highlighted). */
	readonly selectionSnapshot?: unknown;
	/** HTTP User-Agent, if the interaction came via web/api. */
	readonly userAgent?: string;
}

export interface InteractionRecord {
	readonly id: string;
	readonly sessionId: string;
	/** Optional link to the turn that this interaction triggered or belongs to. */
	readonly turnId?: string;
	readonly timestamp: string; // ISO 8601
	readonly source: InteractionSource;
	readonly channel: InteractionChannel;
	readonly type: InteractionRecordType;
	/** Plugin this interaction targets (if any). */
	readonly targetPluginId?: string;
	/** Runtime this interaction targets (if any — e.g. manual runtime trigger). */
	readonly targetRuntimeId?: string;
	/** Raw payload as sent by the client. Schema is per-type. */
	readonly payload: unknown;
	readonly metaData?: InteractionRecordMetaData;
}
