/**
 * Session Snapshot Builder — aggregates all session data for client restore.
 *
 * Single entry point: buildSessionSnapshot(store, sessionId) → SessionSnapshot | null
 *
 * Queries in parallel: session, messages, characters, state entries, trace events.
 * Flattens message metadata and aggregates state entries by table.
 */

import type {
	SessionSnapshot,
	SnapshotMessage,
	SnapshotCharacter,
	SnapshotTraceEvent,
} from "@covel/shared";

/**
 * Minimal store interface for snapshot building.
 * Uses only the read methods it needs.
 *
 * Shape mirrors the post-turn-band SessionRecord: `status` + `turnCount`
 * replace the old `phase` string. Consumers that still want a phase-like
 * label can derive it from those two fields.
 */
export interface SnapshotStore {
	getSession(id: string): Promise<{
		id: string;
		worldId?: string;
		status: string;
		turnCount: number;
		preGameCompleted?: readonly string[];
		locale?: string;
	} | null>;
	listMessages(sessionId: string): Promise<
		readonly {
			id: string;
			role: string;
			content: string;
			metadata?: unknown;
			createdAt: string;
		}[]
	>;
	listCharacters(sessionId: string): Promise<
		readonly {
			id: string;
			name: string;
			type: string;
			description?: string;
			fields?: unknown;
		}[]
	>;
	listStateSchemas(
		sessionId: string,
	): Promise<readonly { tableName: string }[]>;
	listStateEntries(
		sessionId: string,
		tableName: string,
	): Promise<
		readonly { tableName: string; fieldName: string; value: unknown }[]
	>;
	listTraceEvents(sessionId: string): Promise<
		readonly {
			type: string;
			turnId: string;
			payload: unknown;
			createdAt: string;
		}[]
	>;
}

/**
 * Build a complete session snapshot for client restore/reconnection.
 * Returns null if the session doesn't exist.
 */
export async function buildSessionSnapshot(
	store: SnapshotStore,
	sessionId: string,
): Promise<SessionSnapshot | null> {
	const session = await store.getSession(sessionId);
	if (!session) return null;

	// Parallel queries for all session data
	const [rawMessages, characters, stateSchemas, traceEvents] =
		await Promise.all([
			store.listMessages(sessionId),
			store.listCharacters(sessionId),
			store.listStateSchemas(sessionId),
			store.listTraceEvents(sessionId),
		]);

	// Query state entries per table (schemas → entries)
	const stateEntries = (
		await Promise.all(
			stateSchemas.map((s) => store.listStateEntries(sessionId, s.tableName)),
		)
	).flat();

	// Flatten message metadata
	const messages: SnapshotMessage[] = rawMessages.map((m) => {
		const meta = (m.metadata ?? {}) as Record<string, unknown>;
		return {
			id: m.id,
			role: m.role,
			content: m.content,
			turnId: meta.turnId as string | undefined,
			runtimeId: meta.runtimeId as string | undefined,
			kind: meta.kind as string | undefined,
			block: meta.block as Record<string, unknown> | undefined,
			createdAt: m.createdAt,
		};
	});

	// Map characters
	const snapshotCharacters: SnapshotCharacter[] = characters.map((c) => ({
		id: c.id,
		name: c.name,
		type: c.type,
		description: c.description,
		fields: c.fields as Record<string, unknown> | undefined,
	}));

	// Aggregate state entries by table → { table: { field: value } }
	const gameState: Record<string, Record<string, unknown>> = {};
	for (const entry of stateEntries) {
		if (!gameState[entry.tableName]) {
			gameState[entry.tableName] = {};
		}
		gameState[entry.tableName][entry.fieldName] = entry.value;
	}

	// Map trace events
	const executionSteps: SnapshotTraceEvent[] = traceEvents.map((t) => ({
		type: t.type,
		turnId: t.turnId,
		payload: (t.payload ?? {}) as Record<string, unknown>,
		timestamp: t.createdAt,
	}));

	return {
		session: {
			id: session.id,
			worldId: session.worldId,
			// Derive a legacy phase label from (status, turnCount) so snapshot
			// consumers that still read `phase` keep working. T20 will drop this
			// field entirely once every consumer migrates to status+turnCount.
			phase: derivePhase(session.status, session.turnCount),
			turnCount: session.turnCount,
			locale: session.locale,
		},
		messages,
		characters: snapshotCharacters,
		gameState,
		executionSteps,
		plugins: [], // Populated by the route handler from PluginRegistry
	};
}

/**
 * Derive a legacy phase label from the new (status, turnCount) pair.
 * Kept internal to this module — T20 removes the phase field altogether.
 */
function derivePhase(status: string, turnCount: number): string {
	if (status === "ended") return "ended";
	if (status === "paused") return "paused";
	return turnCount === 0 ? "pre-game" : "playing";
}
