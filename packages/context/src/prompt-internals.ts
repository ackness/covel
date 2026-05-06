/**
 * Shared prompt-assembly helpers used by both V1 (`context-builder.ts`) and
 * V2 (`prompt-assembler.ts`).
 *
 * Extracted so the two assemblers share one source of truth for:
 * - template-variable interpolation
 * - inject-block construction
 * - variable-object assembly (the big `variables` record fed to the
 *   interpolator, including `inputs`, `config`, `world`, `session`, `player`)
 * - locale → language-name resolution
 *
 * This module is `@internal` — exports are imported by sibling modules only
 * and are not re-exported from `src/index.ts`. Keeping them private to the
 * package prevents plugin code from reaching in and coupling to internals.
 */

import type {
	InputInjectDecl,
	PluginDataInjectDecl,
	RuntimeInjectDecl,
} from "@covel/shared";
import { isEnvEnabled } from "@covel/shared";
import type { PluginDataRecord } from "./session-context-store.js";
import type { ContextBuildParams, SessionMeta } from "./types.js";

/**
 * Pick the source-of-truth for session-level data inside the prompt-variable
 * assembler. When a `SessionContextSnapshot` is present on the params, it wins
 * over the legacy scattered fields so callers can opt into the snapshot
 * channel without the legacy fields having to be cleared.
 *
 * Kept local to this module — the dual-channel collapse is a Sprint 1 detail
 * and Sprint 2/3 remove the legacy branch entirely.
 */
function resolveVariableSources(params: ContextBuildParams): {
	readonly config: Readonly<Record<string, unknown>>;
	readonly sessionMeta: SessionMeta | undefined;
} {
	if (params.sessionContext) {
		return {
			config: params.sessionContext.legacyConfigView,
			sessionMeta: params.sessionContext.sessionMeta,
		};
	}
	return {
		config: params.config,
		sessionMeta: params.sessionMeta,
	};
}

/**
 * Resolve a dot-separated path against a nested object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(
	obj: Readonly<Record<string, unknown>>,
	path: string,
): unknown {
	const segments = path.split(".");
	let current: unknown = obj;

	for (const segment of segments) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Replace `{{ path }}` template variables in a prompt string.
 * Unresolved variables are replaced with an empty string.
 */
export function interpolateTemplate(
	template: string,
	variables: Readonly<Record<string, unknown>>,
): string {
	return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
		const value = resolvePath(variables, path.trim());
		if (value === undefined || value === null) {
			return "";
		}
		return String(value);
	});
}

/** Extract the tag name from an XML-style tag string like `<narrator-output>`. */
function parseTagName(tag: string): string {
	return tag.replace(/^</, "").replace(/>$/, "");
}

/**
 * Validate that a tag name contains only safe characters (alphanumeric,
 * hyphens, underscores). Throws if the name is empty or contains unsafe chars.
 */
function validateTagName(name: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		throw new Error(
			`[inject] unsafe tag name "${name}" — only alphanumeric, hyphens, and underscores are allowed`,
		);
	}
	return name;
}

/**
 * Escape XML-special characters in content so injected values cannot break
 * the surrounding XML tag structure.
 */
function escapeXmlContent(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Check whether a declaration is the runtime-output variant.
 *
 * The legacy shape has no `kind` field — shared's `inputInjectDeclSchema`
 * normalises it to `kind: 'runtime'` at parse time. So at runtime we can
 * just check the discriminator. For defensive reading of hand-built data
 * (e.g. old fixtures), we also treat `kind === undefined` as `runtime`.
 */
function isRuntimeInject(decl: InputInjectDecl): decl is RuntimeInjectDecl {
	const kind = (decl as { kind?: string }).kind;
	return kind === "runtime" || kind === undefined;
}

function isPluginDataInject(
	decl: InputInjectDecl,
): decl is PluginDataInjectDecl {
	return (decl as { kind?: string }).kind === "plugin-data";
}

/**
 * Resolve a single runtime-output inject to its XML block, or null when
 * the upstream runtime has no output or the named field is absent.
 */
function resolveRuntimeInject(
	inject: RuntimeInjectDecl,
	params: ContextBuildParams,
): string | null {
	const result = params.completedResults.get(inject.from);
	if (!result?.output) return null;

	const value = result.output[inject.field];
	if (value === undefined || value === null) return null;

	const tagName = validateTagName(parseTagName(inject.as));
	return `<${tagName}>${escapeXmlContent(String(value))}</${tagName}>`;
}

/**
 * Build the inject XML blocks from `manifest.input.inject` declarations.
 *
 * Synchronous path — only supports `kind: 'runtime'` entries. Any
 * `kind: 'plugin-data'` entries are silently skipped here; use
 * {@link buildInjectBlocksAsync} when the manifest declares plugin-data
 * injects. Callers decide which path to take by inspecting
 * `manifest.input?.inject` before building the context.
 */
export function buildInjectBlocks(params: ContextBuildParams): string {
	const injects = params.manifest.input?.inject;
	if (!injects || injects.length === 0) {
		return "";
	}

	const blocks: string[] = [];
	for (const inject of injects) {
		if (!isRuntimeInject(inject)) continue;
		const block = resolveRuntimeInject(inject, params);
		if (block) blocks.push(block);
	}
	return blocks.join("\n");
}

/**
 * Async variant of {@link buildInjectBlocks} — handles both `kind: 'runtime'`
 * and `kind: 'plugin-data'` declarations.
 *
 * `plugin-data` entries trigger a `store.listPluginData(sessionId, pluginId,
 * namespace)` call to fetch the runtime's own plugin-data, which is then
 * truncated via {@link twoPassTruncate} and serialised via
 * {@link serializeEntries}. Store errors are not caught — they propagate to
 * the caller so the containing runtime fails cleanly and its error stays on
 * the observability channel (see Phase 0 audit notes in the ticket).
 */
export async function buildInjectBlocksAsync(
	params: ContextBuildParams,
): Promise<string> {
	const injects = params.manifest.input?.inject;
	if (!injects || injects.length === 0) {
		return "";
	}

	const blocks: string[] = [];
	for (const inject of injects) {
		if (isRuntimeInject(inject)) {
			const block = resolveRuntimeInject(inject, params);
			if (block) blocks.push(block);
			continue;
		}

		if (isPluginDataInject(inject)) {
			const block = await resolvePluginDataInject(inject, params);
			if (block) blocks.push(block);
			continue;
		}
	}
	return blocks.join("\n");
}

/**
 * Resolve a `kind: 'plugin-data'` inject to an XML block.
 *
 * Calls `store.listPluginData(sessionId, pluginId, namespace)` — pluginId
 * comes from the runtime's own manifest, so cross-plugin reads are
 * structurally impossible through this path. Errors bubble up to the
 * caller (runtime fail → Phase 0 audit guarantees no context pollution).
 */
async function resolvePluginDataInject(
	inject: PluginDataInjectDecl,
	params: ContextBuildParams,
): Promise<string> {
	if (!params.store) {
		throw new Error(
			`[plugin-data inject] store is required for runtime "${params.manifest.name}" ` +
				`but was not provided to buildContextAsync`,
		);
	}

	const entries = await params.store.listPluginData(
		params.turnInput.sessionId,
		params.manifest.pluginId,
		inject.namespace,
	);

	const tagName = validateTagName(parseTagName(inject.as));

	if (entries.length === 0) {
		return `<${tagName}>暂无</${tagName}>`;
	}

	const format = inject.format ?? "summary";
	const maxEntries = inject.maxEntries ?? 50;
	const truncated = twoPassTruncate(entries, maxEntries);
	const serialized = escapeXmlContent(serializeEntries(truncated, format));
	const countLine =
		entries.length > truncated.length
			? `\n[总计 ${entries.length} 条，展示 ${truncated.length} 条]`
			: "";

	return `<${tagName}>\n${serialized}${countLine}\n</${tagName}>`;
}

/**
 * Two-pass deterministic truncation for plugin-data summaries.
 *
 * When the namespace has fewer rows than `max`, returns them in their
 * natural order (caller-observed). Otherwise splits the quota:
 *
 * - **Anchor half** (`floor(max/2)`): oldest entries by `createdAt` — keeps
 *   long-lived references visible even in late-game turns, so the LLM can
 *   still match early-session codex entries when narrating a callback.
 * - **Recent half** (`max - floor(max/2)`): most recently updated entries
 *   by `updatedAt`, excluding anything already in the anchor half.
 *
 * The returned array orders anchors first, then recent entries, so the
 * LLM reads a stable timeline-like layout. Deduplication by `key` ensures
 * an entry never appears twice in the output even when it qualifies for
 * both slices.
 */
export function twoPassTruncate(
	entries: readonly PluginDataRecord[],
	max: number,
): PluginDataRecord[] {
	if (entries.length <= max) return [...entries];

	const anchorQuota = Math.floor(max / 2);
	const recentQuota = max - anchorQuota;

	const byCreatedAsc = [...entries].sort((a, b) => {
		const diff = a.createdAt.localeCompare(b.createdAt);
		if (diff !== 0) return diff;
		return a.key.localeCompare(b.key);
	});
	const anchors = byCreatedAsc.slice(0, anchorQuota);
	const anchorKeys = new Set(anchors.map((e) => e.key));

	const byUpdatedDesc = [...entries]
		.filter((e) => !anchorKeys.has(e.key))
		.sort((a, b) => {
			const diff = b.updatedAt.localeCompare(a.updatedAt);
			if (diff !== 0) return diff;
			return a.key.localeCompare(b.key);
		});
	const recent = byUpdatedDesc.slice(0, recentQuota);

	return [...anchors, ...recent];
}

const SUMMARY_VALUE_CAP = 200;

/**
 * Serialise a truncated plugin-data slice per the declared format.
 *
 * `summary` stays agnostic of the value schema — it stringifies each value
 * to JSON and truncates to 200 chars. This keeps the helper decoupled from
 * any plugin's internal record shape (codex uses `{title, content, tags,
 * rarity}`, character-tracker uses something else, etc).
 */
export function serializeEntries(
	entries: readonly PluginDataRecord[],
	format: "summary" | "full" | "ids-only",
): string {
	return entries.map((entry) => formatEntry(entry, format)).join("\n");
}

function formatEntry(
	entry: PluginDataRecord,
	format: "summary" | "full" | "ids-only",
): string {
	if (format === "ids-only") {
		return `- ${entry.key}`;
	}
	const json = safeStringify(entry.value);
	if (format === "full") {
		return `- ${entry.key}: ${json}`;
	}
	// summary
	const compact =
		json.length > SUMMARY_VALUE_CAP
			? `${json.slice(0, SUMMARY_VALUE_CAP)}...`
			: json;
	return `- ${entry.key} | ${entry.updatedAt} | ${compact}`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * Assemble the full variables object consumed by `interpolateTemplate`.
 *
 * Mirrors the logic previously inlined in `buildContext`. Both V1 and V2
 * call this so the variable surface stays identical and plugin templates
 * see the same data regardless of which assembler is active.
 */
export function assemblePromptVariables(
	params: ContextBuildParams,
): Record<string, unknown> {
	const { turnInput, completedResults } = params;
	const { config, sessionMeta } = resolveVariableSources(params);

	// Build the `inputs` lookup map: pluginId → runtimeId → output.
	const inputsMap: Record<string, Record<string, Record<string, unknown>>> = {};
	for (const [key, result] of completedResults) {
		if (!result.output) continue;
		const slashIdx = key.indexOf("/");
		// Single-runtime: name = "narrator" → pluginId = runtimeId = "narrator"
		// Multi-runtime:  name = "world-init/schema-gen" → pluginId = "world-init", runtimeId = "schema-gen"
		const pluginId = slashIdx >= 0 ? key.slice(0, slashIdx) : key;
		const runtimeId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
		if (!inputsMap[pluginId]) {
			inputsMap[pluginId] = {};
		}
		inputsMap[pluginId][runtimeId] = result.output;
	}

	// Build a `world` convenience object from config.world* keys so plugin
	// templates can use `{{ world.lore }}`, `{{ world.dimensions }}`, etc.
	const world: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (key.startsWith("world") && key.length > 5) {
			// worldLore → lore, worldDimensions → dimensions, worldEntries → entries, etc.
			const shortKey = key[5]!.toLowerCase() + key.slice(6);
			world[shortKey] = value;
		}
	}

	const playerChar =
		sessionMeta?.characters?.find((c) => c.type === "player") ?? null;

	// Stringify the latest form submission so template interpolation renders
	// a JSON blob (LLM-friendly) instead of "[object Object]".
	const lastFormValuesRaw = sessionMeta?.lastFormValues;
	const lastFormValuesStr =
		lastFormValuesRaw && Object.keys(lastFormValuesRaw).length > 0
			? JSON.stringify(lastFormValuesRaw, null, 2)
			: "";

	return {
		inputs: inputsMap,
		config,
		...config,
		world,
		session: {
			id: turnInput.sessionId,
			turnNumber: sessionMeta?.turnNumber ?? 0,
			phase: (sessionMeta?.turnNumber ?? 0) === 0 ? "pre-game" : "playing",
		},
		player: {
			message: turnInput.playerMessage,
			character: playerChar,
			lastFormValues: lastFormValuesStr,
			lastFormValuesRaw,
		},
		// Player-authored plugin settings, merged with manifest.userSettings[].default.
		// Undefined when the manifest declares none — dot-path lookups then return
		// empty strings, matching the behaviour of any other missing variable.
		userSettings: params.userSettings ?? {},
	};
}

/**
 * Build the current-turn user message passed to the LLM.
 *
 * Empty player input commonly happens on framework-driven turns such as
 * `start_session`. In that case we supply a compact execution cue so models
 * stay inside the runtime task instead of drifting into assistant small talk.
 */
export function buildCurrentTurnUserMessage(
	turnInput: Pick<
		ContextBuildParams["turnInput"],
		"playerMessage" | "locale" | "manualTrigger"
	>,
): string {
	if (turnInput.playerMessage.trim().length > 0) {
		return turnInput.playerMessage;
	}

	const locale = turnInput.locale ?? "";
	if (turnInput.manualTrigger) {
		const runtimeId = turnInput.manualTrigger.runtimeId;
		if (locale === "zh" || locale.startsWith("zh-")) {
			return `执行当前手动触发的 runtime：${runtimeId}。严格遵循系统提示中的输出格式，产出该 runtime 的结果。`;
		}

		return `Execute the current manually triggered runtime: ${runtimeId}. Follow the output format in the system prompt exactly and produce this runtime's result.`;
	}

	if (locale === "zh" || locale.startsWith("zh-")) {
		return "开始当前游戏回合，并按照系统设定直接给出游戏内结果。";
	}

	return "Begin the current game turn and produce the in-game result defined by the system instructions.";
}

/**
 * Framework preamble used by V2 prompt assembly (segment 1).
 *
 * When a locale is provided, prepends a `[RUNTIME]` header that keeps
 * task-general assistants from drifting outside the interactive-narrative
 * frame, then appends the `[LANGUAGE]` constraint. When no locale is
 * supplied this returns an empty string so segment 1 is skipped — preserving
 * V1/V2 byte-identity in the locale-less baseline.
 */
export function buildFrameworkPreamble(locale?: string): string {
	if (!locale) {
		return "";
	}

	const languageName = resolveLocaleLanguageName(locale);
	return [
		"[RUNTIME] You are executing an in-game runtime for an interactive narrative engine.",
		"[RUNTIME] Follow the runtime instructions and world data below as the complete task context.",
		"[RUNTIME] Produce only in-world narrative, structured runtime output, and required tool calls.",
		`[LANGUAGE] You MUST respond in ${languageName}. All narrative output, tool parameters, and descriptions must be in ${languageName}.`,
		// Framework completion contract — see packages/tools/src/builtin/runtime-done.ts
		// and the tool_calls early-exit branch in turn-executor.ts. Without this
		// preamble, agent runtimes waste a round-trip on a terminator message after
		// every successful tool call.
		"[COMPLETION] 本 runtime 完成所有业务工具调用后，必须立即调用 `runtime-done` 工具结束。不要输出额外终止文本——调用 `runtime-done` 就是结束信号。",
		"[COMPLETION] 如果判断本回合无需任何工具调用，直接调用 `runtime-done` 结束（优先）或返回空字符串。不要反复调用同一个业务工具。",
		"[COMPLETION] When you have finished all tool work for this runtime, call the `runtime-done` tool IMMEDIATELY. Do not emit terminator text.",
	].join("\n");
}

/**
 * Render Working Memory entries as a prompt segment (S3-T3).
 *
 * Sorting is deterministic: scope order `player` → `story` → `shared`,
 * then alphabetical key within scope. If no entries exist, returns an
 * empty string so callers can skip the segment.
 *
 * Gated by `COVEL_WORKING_MEMORY_V1=1`. When unset, returns empty string
 * unconditionally so the feature has zero overhead when disabled.
 */
export function renderWorkingMemory(
	entries:
		| readonly {
				scope: "player" | "story" | "shared";
				key: string;
				value: unknown;
		  }[]
		| undefined,
): string {
	if (!isEnvEnabled("COVEL_WORKING_MEMORY_V1")) {
		return "";
	}
	if (!entries || entries.length === 0) {
		return "";
	}

	const scopeOrder: Record<string, number> = { player: 0, story: 1, shared: 2 };
	const sorted = [...entries].sort((a, b) => {
		const scopeDiff = (scopeOrder[a.scope] ?? 99) - (scopeOrder[b.scope] ?? 99);
		if (scopeDiff !== 0) return scopeDiff;
		return a.key.localeCompare(b.key);
	});

	const lines = sorted.map((entry) => {
		const valueStr =
			typeof entry.value === "string"
				? JSON.stringify(entry.value)
				: JSON.stringify(entry.value);
		return `${entry.scope}.${entry.key}: ${valueStr}`;
	});

	return `[Working Memory]\n${lines.join("\n")}`;
}

/**
 * Render core memory blocks as a `[Core Memory]` prompt section.
 *
 * Core memory blocks (inspired by Letta/MemGPT) are small editable text
 * segments that provide the LLM with persistent story state across turns.
 * They are placed in the prompt between framework preamble and message
 * history, replacing the need for full history injection.
 *
 * Gated by `COVEL_MEMORY_V1=1`. When unset, returns empty string.
 */
export function renderCoreMemory(
	blocks: readonly { label: string; content: string }[] | undefined,
	locale?: string,
): string {
	if (!isEnvEnabled("COVEL_MEMORY_V1")) return "";
	if (!blocks || blocks.length === 0) return "";

	const nonEmpty = blocks.filter((b) => b.content.trim());
	if (nonEmpty.length === 0) return "";

	const labels: Record<string, string> = locale?.startsWith("en")
		? {
				story_state: "Story State",
				scene: "Current Scene",
				character_relationships: "Character Relationships",
				player_profile: "Player Profile",
			}
		: {
				story_state: "剧情状态",
				scene: "当前场景",
				character_relationships: "角色关系",
				player_profile: "玩家状态",
			};

	const header = locale?.startsWith("en") ? "[Core Memory]" : "[核心记忆]";
	const sections = nonEmpty.map((b) => {
		const label = labels[b.label] ?? b.label;
		return `<${b.label}>\n# ${label}\n${b.content}\n</${b.label}>`;
	});

	return `${header}\n${sections.join("\n\n")}`;
}

/**
 * Map a locale code (BCP-47) to a human-readable language name used in
 * the framework preamble. Falls back to the raw locale string if unknown.
 */
export function resolveLocaleLanguageName(locale: string): string {
	const langMap: Record<string, string> = {
		"zh-CN": "中文",
		zh: "中文",
		"en-US": "English",
		en: "English",
		ja: "日本語",
		ko: "한국어",
	};
	return langMap[locale] ?? locale;
}
