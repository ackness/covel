/**
 * Session-level context snapshot loader (Sprint 1-B).
 *
 * Collapses the scattered store reads spread across `turn-executor.ts` and
 * `apps/server/src/routes/api/load-session-config.ts` into a single
 * deterministic async call. Returns a strictly-readonly snapshot built once
 * per turn.
 *
 * Invariants:
 *  1. All store reads are guarded (method existence probe + try/catch).
 *     Loader failures never throw; missing data degrades to empty shapes.
 *  2. `legacyConfigView` is byte-identical to `loadSessionConfig` output —
 *     same keys, same insertion order, "key absent when source empty" rule.
 *  3. World-data-provider plugin id is caller-supplied (discovered by the
 *     `world-data-provider` capability tag) — never hardcoded here.
 *  4. `coreMemoryBlocks` / `summaries` are caller-resolved inputs; the
 *     loader does not read feature flags.
 */

import type {
	LorebookEntryRecord,
	PluginDataRecord,
	SessionContextStore,
	WorldRecord,
	WorkingMemoryRecord,
} from "./session-context-store.js";
import type {
	CharacterSummary,
	ContextContribution,
	CoreMemoryBlockView,
	LorebookEntryView,
	PersonaProfile,
	SessionContextSnapshot,
	SummaryRecord,
	WorkingMemoryEntry,
} from "./types.js";
import {
	buildLegacyConfigView,
	buildWorldContextView,
} from "./session-context-views.js";

/**
 * Options for `buildSessionContextSnapshot`. Caller supplies flag-gated
 * inputs (core memory, summaries) already resolved; the snapshot loader
 * does not inspect environment flags.
 */
export interface BuildSessionContextSnapshotOpts {
	/** Locale for this turn. Usually resolved from request → session → world default → app default (`zh-CN`). */
	readonly locale: string;
	/** Current turn number (player messages completed pre-turn). Caller computes. */
	readonly turnNumber: number;
	/** World this session is bound to. Used to load `WorldContextView`. */
	readonly worldId?: string;
	/**
	 * Plugin ID of the world-data-provider (discovered by `world-data-provider`
	 * capability tag in bootstrap). Drives `legacyConfigView.worldEntries` /
	 * `.worldSchema` loading. Framework must NEVER hardcode a plugin id.
	 */
	readonly worldDataPluginId?: string;
	/**
	 * Pre-loaded core memory blocks. Caller decides whether to load them
	 * based on `COVEL_MEMORY_V1` + memorySystem availability.
	 * Defaults to `[]`.
	 */
	readonly coreMemoryBlocks?: readonly CoreMemoryBlockView[];
	/**
	 * Pre-loaded session summaries. Caller decides whether to load them
	 * based on `COVEL_COMPACTOR_V1`. Defaults to `[]`.
	 */
	readonly summaries?: readonly SummaryRecord[];
	/** Current player text for selective lorebook activation. */
	readonly playerMessage?: string;
}

export async function buildSessionContextSnapshot(
	store: SessionContextStore,
	sessionId: string,
	opts: BuildSessionContextSnapshotOpts,
): Promise<SessionContextSnapshot> {
	// Session read is for completeness — caller already gates on active status.
	const [
		,
		characters,
		lastFormValues,
		workingMemory,
		lorebookRecords,
		activePersona,
	] = await Promise.all([
		safeGetSession(store, sessionId),
		loadCharacters(store, sessionId),
		loadLastFormValues(store, sessionId),
		loadWorkingMemory(store, sessionId),
		loadLorebookRecords(store, sessionId),
		loadActivePersona(store, sessionId),
	]);

	const worldRecord = opts.worldId
		? await safeGetWorld(store, opts.worldId)
		: null;

	const [worldSchema, worldEntriesMap] = await Promise.all([
		loadWorldSchema(store, sessionId, opts.worldDataPluginId),
		loadWorldEntries(store, sessionId, opts.worldDataPluginId, lorebookRecords),
	]);

	return {
		sessionId,
		turnNumber: opts.turnNumber,
		locale: opts.locale,
		sessionMeta: { turnNumber: opts.turnNumber, characters, lastFormValues },
		world: buildWorldContextView({
			worldId: opts.worldId,
			worldRecord,
			schemaMap: worldSchema,
			entriesMap: worldEntriesMap,
		}),
		characters,
		workingMemory,
		coreMemoryBlocks: opts.coreMemoryBlocks ?? [],
		loreEntries: lorebookRecords.map(toLorebookEntryView),
		summaries: opts.summaries ?? [],
		legacyConfigView: buildLegacyConfigView({
			worldRecord,
			schemaMap: worldSchema,
			entriesMap: worldEntriesMap,
		}),
		...(activePersona ? { activePersona } : {}),
		contributions: [
			...compileLorebookContributions(
				lorebookRecords,
				opts.playerMessage ?? "",
			),
			...(activePersona ? [compilePersonaContribution(activePersona)] : []),
		],
	};
}

// ── Per-source loaders ──────────────────────────────────────────────

async function safeGetSession(store: SessionContextStore, sessionId: string) {
	try {
		return await store.getSession(sessionId);
	} catch {
		return null;
	}
}

async function loadCharacters(
	store: SessionContextStore,
	sessionId: string,
): Promise<readonly CharacterSummary[]> {
	try {
		const records = await store.listCharacters(sessionId);
		return records.map((c) => ({
			name: c.name,
			type: c.type,
			description: c.description,
			fields:
				c.fields && typeof c.fields === "object"
					? (c.fields as Record<string, unknown>)
					: undefined,
		}));
	} catch {
		return [];
	}
}

async function loadLastFormValues(
	store: SessionContextStore,
	sessionId: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	// Non-critical: player inputs may not exist yet
	try {
		const inputs = await store.listPlayerInputs(sessionId);
		if (inputs.length === 0) return undefined;
		const latest = inputs[inputs.length - 1];
		if (latest?.values && typeof latest.values === "object") {
			return latest.values as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function loadWorkingMemory(
	store: SessionContextStore,
	sessionId: string,
): Promise<readonly WorkingMemoryEntry[]> {
	if (typeof store.listWorkingMemory !== "function") return [];
	try {
		const records: readonly WorkingMemoryRecord[] =
			await store.listWorkingMemory(sessionId);
		return records.map((r) => ({ scope: r.scope, key: r.key, value: r.value }));
	} catch {
		return [];
	}
}

async function loadLorebookRecords(
	store: SessionContextStore,
	sessionId: string,
): Promise<readonly LorebookEntryRecord[]> {
	if (typeof store.listSessionLorebookEntries !== "function") return [];
	try {
		return await store.listSessionLorebookEntries(sessionId);
	} catch {
		return [];
	}
}

async function loadActivePersona(
	store: SessionContextStore,
	sessionId: string,
): Promise<PersonaProfile | undefined> {
	try {
		const bindings = await store.listPluginData(
			sessionId,
			"player-identity",
			"session-binding",
		);
		const current = bindings.find((record) => record.key === "current");
		const bindingValue = current?.value;
		if (!bindingValue || typeof bindingValue !== "object") return undefined;
		const profileId = (bindingValue as Record<string, unknown>).profileId;
		if (typeof profileId !== "string" || profileId.length === 0)
			return undefined;

		const profiles = await store.listPluginData(
			sessionId,
			"player-identity",
			"profiles",
		);
		const profileRecord = profiles.find((record) => record.key === profileId);
		return normalizePersonaProfile(profileRecord?.value, profileId);
	} catch {
		return undefined;
	}
}

function normalizePersonaProfile(
	value: unknown,
	profileId: string,
): PersonaProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	const rawProfile = record.profile ?? value;
	if (
		!rawProfile ||
		typeof rawProfile !== "object" ||
		Array.isArray(rawProfile)
	)
		return undefined;
	const profile = rawProfile as Record<string, unknown>;
	const id =
		typeof profile.id === "string" && profile.id.length > 0
			? profile.id
			: profileId;
	const name =
		typeof profile.name === "string" && profile.name.length > 0
			? profile.name
			: id;
	const description =
		typeof profile.description === "string" ? profile.description : undefined;
	const coordinate = normalizePersonaCoordinate(profile.promptCoordinate);
	const loreEntryIds = Array.isArray(profile.loreEntryIds)
		? profile.loreEntryIds.filter(
				(entryId): entryId is string => typeof entryId === "string",
			)
		: undefined;
	return {
		id,
		name,
		...(description ? { description } : {}),
		...(coordinate ? { promptCoordinate: coordinate } : {}),
		...(loreEntryIds && loreEntryIds.length > 0 ? { loreEntryIds } : {}),
	};
}

function normalizePersonaCoordinate(
	value: unknown,
): PersonaProfile["promptCoordinate"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const coordinate = value as Record<string, unknown>;
	const position = coordinate.position;
	if (
		position !== "seg3_prepend" &&
		position !== "seg3_append" &&
		position !== "at_depth"
	) {
		return undefined;
	}
	const depth =
		typeof coordinate.depth === "number" && Number.isFinite(coordinate.depth)
			? Math.max(0, Math.round(coordinate.depth))
			: undefined;
	const order =
		typeof coordinate.order === "number" && Number.isFinite(coordinate.order)
			? coordinate.order
			: undefined;
	return {
		position,
		...(depth !== undefined ? { depth } : {}),
		...(order !== undefined ? { order } : {}),
	};
}

function compilePersonaContribution(
	persona: PersonaProfile,
): ContextContribution {
	const coordinate = persona.promptCoordinate;
	const content = [
		"[Player Persona]",
		`Name: ${persona.name}`,
		persona.description ? `Description: ${persona.description}` : "",
	]
		.filter(Boolean)
		.join("\n");

	return {
		kind: "persona_description",
		sourceType: "persona",
		sourceId: persona.id,
		content,
		position: coordinate?.position ?? "seg3_prepend",
		...(coordinate?.depth !== undefined ? { depth: coordinate.depth } : {}),
		order: coordinate?.order ?? 0,
		budgetClass: "sticky",
	};
}

function compileLorebookContributions(
	records: readonly LorebookEntryRecord[],
	playerMessage: string,
): readonly ContextContribution[] {
	return records
		.filter((record) => record.enabled)
		.filter((record) => isLorebookEntryActive(record, playerMessage))
		.slice()
		.sort(
			(a, b) => a.insertionOrder - b.insertionOrder || a.id.localeCompare(b.id),
		)
		.map((record) => {
			const extra = normalizeLorebookExtra(record.extra);
			const coordinate = normalizeLorebookCoordinate(
				record.position,
				extra.coordinate,
			);
			return {
				kind: "lore_entry",
				sourceType: "world",
				sourceId: record.id,
				content: formatLorebookContributionContent(record, extra.title),
				position: coordinate.position,
				...(coordinate.depth !== undefined ? { depth: coordinate.depth } : {}),
				order: record.insertionOrder,
				budgetClass: extra.budgetClass ?? "flexible",
				debugTrace: {
					pluginId: record.pluginId,
					strategy: record.strategy,
					keys: record.keys,
					...(extra.sourceRuleId ? { sourceRuleId: extra.sourceRuleId } : {}),
				},
			};
		});
}

function isLorebookEntryActive(
	record: LorebookEntryRecord,
	playerMessage: string,
): boolean {
	if (record.strategy === "constant") return true;
	if (!record.keys || record.keys.length === 0) return false;
	const haystack = playerMessage.toLowerCase();
	return record.keys.some(
		(key) => key.length > 0 && haystack.includes(key.toLowerCase()),
	);
}

interface NormalizedLorebookExtra {
	readonly title?: string;
	readonly coordinate?: {
		readonly position?: unknown;
		readonly depth?: unknown;
	};
	readonly budgetClass?: "sticky" | "flexible" | "droppable";
	readonly sourceRuleId?: string;
}

function normalizeLorebookExtra(value: unknown): NormalizedLorebookExtra {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const root = value as Record<string, unknown>;
	const nestedExtra =
		root.extra && typeof root.extra === "object" && !Array.isArray(root.extra)
			? (root.extra as Record<string, unknown>)
			: undefined;
	const source = nestedExtra ?? root;
	const budgetClass = source.budgetClass;
	return {
		...(typeof source.title === "string" && source.title.length > 0
			? { title: source.title }
			: {}),
		...(source.coordinate &&
		typeof source.coordinate === "object" &&
		!Array.isArray(source.coordinate)
			? {
					coordinate:
						source.coordinate as NormalizedLorebookExtra["coordinate"],
				}
			: {}),
		...(budgetClass === "sticky" ||
		budgetClass === "flexible" ||
		budgetClass === "droppable"
			? { budgetClass }
			: {}),
		...(typeof source.sourceRuleId === "string"
			? { sourceRuleId: source.sourceRuleId }
			: {}),
	};
}

function normalizeLorebookCoordinate(
	recordPosition: string,
	extraCoordinate: NormalizedLorebookExtra["coordinate"],
): {
	readonly position: "before_plugin" | "after_plugin" | "at_depth";
	readonly depth?: number;
} {
	const candidate =
		typeof extraCoordinate?.position === "string"
			? extraCoordinate.position
			: recordPosition;
	const position =
		candidate === "before_plugin" || candidate === "before-memory"
			? "before_plugin"
			: candidate === "at_depth"
				? "at_depth"
				: "after_plugin";
	const depth =
		typeof extraCoordinate?.depth === "number" &&
		Number.isFinite(extraCoordinate.depth)
			? Math.max(0, Math.round(extraCoordinate.depth))
			: undefined;
	return {
		position,
		...(position === "at_depth" && depth !== undefined ? { depth } : {}),
	};
}

function formatLorebookContributionContent(
	record: LorebookEntryRecord,
	title?: string,
): string {
	const label =
		title ??
		(record.keys && record.keys.length > 0 ? record.keys[0] : record.id);
	return [`[World Rule: ${label}]`, record.content].join("\n");
}

function toLorebookEntryView(r: LorebookEntryRecord): LorebookEntryView {
	const extraFromRecord =
		r.extra && typeof r.extra === "object"
			? (r.extra as Record<string, unknown>)
			: undefined;
	return {
		id: r.id,
		pluginId: r.pluginId,
		content: r.content,
		keys: r.keys,
		enabled: r.enabled,
		extra: {
			strategy: r.strategy,
			position: r.position,
			insertionOrder: r.insertionOrder,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			...(extraFromRecord ? { extra: extraFromRecord } : {}),
		},
	};
}

async function safeGetWorld(
	store: SessionContextStore,
	worldId: string,
): Promise<WorldRecord | null> {
	try {
		return await store.getWorld(worldId);
	} catch {
		return null;
	}
}

async function loadWorldSchema(
	store: SessionContextStore,
	sessionId: string,
	worldDataPluginId: string | undefined,
): Promise<Record<string, unknown> | undefined> {
	if (!worldDataPluginId) return undefined;
	try {
		const records = await store.listPluginData(
			sessionId,
			worldDataPluginId,
			"schema",
		);
		if (records.length === 0) return undefined;
		const map: Record<string, unknown> = {};
		for (const r of records) map[r.key] = r.value;
		return map;
	} catch {
		return undefined;
	}
}

async function loadWorldEntries(
	store: SessionContextStore,
	sessionId: string,
	worldDataPluginId: string | undefined,
	lorebookRecords: readonly LorebookEntryRecord[],
): Promise<Record<string, unknown> | undefined> {
	if (!worldDataPluginId) return undefined;
	// Prefer lorebook (canonical, FU-8) — matches `readLorebookWorldEntries`
	// in `load-session-config.ts`.
	const lorebookMap = lorebookWorldEntriesMap(
		lorebookRecords,
		worldDataPluginId,
	);
	if (lorebookMap !== undefined) return lorebookMap;
	try {
		const entryRecords: readonly PluginDataRecord[] =
			await store.listPluginData(sessionId, worldDataPluginId, "entries");
		if (entryRecords.length === 0) return undefined;
		const map: Record<string, unknown> = {};
		for (const r of entryRecords) map[r.key] = r.value;
		return map;
	} catch {
		return undefined;
	}
}

function lorebookWorldEntriesMap(
	records: readonly LorebookEntryRecord[],
	worldDataPluginId: string,
): Record<string, unknown> | undefined {
	const relevant = records
		.filter(
			(e) =>
				e.pluginId === worldDataPluginId &&
				e.strategy === "constant" &&
				e.enabled,
		)
		.slice()
		.sort((a, b) => a.insertionOrder - b.insertionOrder);
	if (relevant.length === 0) return undefined;
	const map: Record<string, unknown> = {};
	for (const entry of relevant) {
		const key = entry.keys && entry.keys.length > 0 ? entry.keys[0] : entry.id;
		map[key] = entry.content;
	}
	return map;
}
