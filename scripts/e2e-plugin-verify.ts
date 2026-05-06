/**
 * Covel E2E Plugin Verification
 * =============================
 *
 * A framework-neutral end-to-end harness that drives the full game pipeline
 * through HTTP APIs (no frontend clicks) and observes per-runtime execution.
 *
 * Design principles:
 *
 *   1. No hardcoded plugin list. All plugin/runtime metadata comes from
 *      GET /api/plugin-flows at runtime, so adding a new plugin "just works"
 *      without touching this script.
 *
 *   2. Real config by default. Story-runtime LLM calls are routed through
 *      the `e2e` slot via the `model` override field on /api/actions.
 *      Slot names are the bare part of `[covel.xxx]` in llm.toml (i.e. `e2e`,
 *      `e2e_local`, `e2e3`), not the full `covel.xxx` table path.
 *      Override with `--slot <name>` or `E2E_MODEL_SLOT=<name>`.
 *
 *   3. Observable output. Each turn prints a runtime timeline, tool calls,
 *      trigger verification, and session-state delta. Plain text, no
 *      emoji, no ANSI colour, stable column widths.
 *
 *   4. Auto form handling. Character creation (or any plugin-produced form)
 *      is detected from runtimeResults and auto-submitted with user-supplied
 *      or default values, mirroring what the web frontend would do.
 *
 *   5. Focus mode. `--runtime <id>` / `--plugin <id>` filter output and
 *      assertions to a single runtime without disabling the rest — runtime
 *      dependencies are preserved.
 *
 *   6. Log persistence. Every run mirrors its stdout to a timestamped file
 *      under `debugs/e2e-logs/` along with a JSON dump of the full turn
 *      history and final session snapshot. Disable with `--no-log`.
 *
 * Usage:
 *   npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts [options]
 *
 * Options:
 *   --server <url>         API base (default: http://localhost:3001/api)
 *   --slot <name>          Model slot for story runtimes (default: e2e)
 *   --world <id>           World to use (default: first world returned by /api/worlds)
 *   --turns <n>            Number of playing-phase turns to run after char-creation (default: 3)
 *   --runtime <id>         Filter output + assertions to this runtime only
 *   --plugin <id>          Filter output + assertions to this plugin only
 *   --player-message <str> Player text for each playing turn (default: cycles through built-ins)
 *   --form-values <json>   Default form field values (default: auto from field types)
 *   --timeout <seconds>    Per-turn SSE timeout (default: 300)
 *   --log-dir <path>       Directory for log artefacts (default: debugs/e2e-logs)
 *   --no-log               Disable log persistence
 *   --verbose              Print verbose SSE event log
 *   --keep                 Keep session after test (default: delete if passed)
 *   --help                 Show this help
 *
 * Exit codes:
 *   0   all assertions passed
 *   1   one or more assertions failed
 *   2   infrastructure failure (HTTP, timeout, malformed response)
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { writeFileSync } from "node:fs";

// ──────────────────────────────────────────────────────────────────
// CLI argument parsing
// ──────────────────────────────────────────────────────────────────

interface CliArgs {
	server: string;
	slot: string;
	world?: string;
	turns: number;
	runtimeFilter?: string;
	pluginFilter?: string;
	playerMessage?: string;
	formValues: Record<string, string>;
	timeoutSec: number;
	verbose: boolean;
	keep: boolean;
	logDir: string;
	logEnabled: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		server: "http://localhost:3001/api",
		slot: process.env.E2E_MODEL_SLOT?.trim() || "e2e",
		turns: 3,
		formValues: {},
		timeoutSec: 300,
		verbose: false,
		keep: false,
		logDir: "debugs/e2e-logs",
		logEnabled: true,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			case "--server":
				args.server = next();
				break;
			case "--slot":
				args.slot = next();
				break;
			case "--world":
				args.world = next();
				break;
			case "--turns":
				args.turns = Number.parseInt(next(), 10);
				break;
			case "--runtime":
				args.runtimeFilter = next();
				break;
			case "--plugin":
				args.pluginFilter = next();
				break;
			case "--player-message":
				args.playerMessage = next();
				break;
			case "--form-values":
				try {
					args.formValues = JSON.parse(next());
				} catch {
					throw new Error(`--form-values must be valid JSON`);
				}
				break;
			case "--timeout":
				args.timeoutSec = Number.parseInt(next(), 10);
				break;
			case "--log-dir":
				args.logDir = next();
				break;
			case "--no-log":
				args.logEnabled = false;
				break;
			case "--verbose":
				args.verbose = true;
				break;
			case "--keep":
				args.keep = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.server.startsWith("http")) {
		throw new Error("--server must start with http:// or https://");
	}
	if (args.turns < 0) throw new Error("--turns must be >= 0");
	if (args.timeoutSec <= 0) throw new Error("--timeout must be > 0");

	return args;
}

function printHelp(): void {
	const help = `
Covel E2E Plugin Verification

Usage:
  npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts [options]

Options:
  --server <url>          API base (default: http://localhost:3001/api)
  --slot <name>           Model slot for story runtimes (default: e2e)
                          Slot names come from [covel.xxx] in llm.toml,
                          pass only the xxx part (e.g. e2e, e2e_local)
  --world <id>            World to use (default: first available)
  --turns <n>             Playing-phase turns after char creation (default: 3)
  --runtime <id>          Filter output + assertions to this runtime only
  --plugin <id>           Filter output + assertions to this plugin only
  --player-message <str>  Player text for each playing turn
  --form-values <json>    Default form field values
  --timeout <seconds>     Per-turn SSE timeout (default: 300)
  --log-dir <path>        Directory for log artefacts (default: debugs/e2e-logs)
  --no-log                Disable log persistence
  --verbose               Print verbose SSE event log
  --keep                  Keep session after test
  --help                  Show this help
`;
	console.log(help.trim());
}

// ──────────────────────────────────────────────────────────────────
// Types mirroring server responses
// ──────────────────────────────────────────────────────────────────

interface PluginFlowTrigger {
	type: string;
	interval?: number;
	cooldownTurns?: number;
	maxTriggerCount?: number;
	startTurn?: number;
}

interface PluginFlowStep {
	id: string;
	pluginId: string;
	pluginName: string;
	runtimeId: string;
	runtimeName: string;
	priority: number;
	segmentId:
		| "start"
		| "pre-game"
		| "pre-narrator"
		| "narrator"
		| "post-narrator";
	runtimeType: string;
	outputKind: string;
	trigger: PluginFlowTrigger;
	tools: { builtin: string[]; local: string[] };
	isStoryRuntime: boolean;
}

interface PluginFlowResponse {
	version: string;
	segments: Array<{
		id: string;
		label: string;
		rangeLabel: string;
		minPriority: number;
		maxPriority: number;
	}>;
	plugins: Array<{
		id: string;
		name: string;
		pluginType: string;
		runtimeIds: string[];
	}>;
	steps: PluginFlowStep[];
}

interface SessionRecord {
	id: string;
	worldId?: string;
	status: string;
	turnCount: number;
	preGameCompleted?: readonly string[];
	locale?: string;
	activePlugins?: readonly string[];
	createdAt?: string;
	updatedAt?: string;
}

interface ToolCallRecord {
	toolName: string;
	input?: unknown;
	output?: unknown;
	approvalStatus?: string;
	durationMs?: number;
	status?: string;
}

interface RuntimeResultRecord {
	runtimeId: string;
	pluginId: string;
	status: string;
	output?: Record<string, unknown>;
	toolCalls?: ToolCallRecord[];
	durationMs: number;
}

interface TurnRecord {
	turnId: string;
	sessionId: string;
	runtimeResults: RuntimeResultRecord[];
	durationMs: number;
	timestamp: string;
}

interface SseEvent {
	type: string;
	payload: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────────────────────────

/**
 * GET with small retry on transient network errors. After an SSE stream
 * terminates unexpectedly the undici connection pool can hold onto a dead
 * keep-alive socket, causing the next fetch() to fail with `TypeError:
 * fetch failed` before eventually reaping it. Retrying past the first
 * flaky attempt recovers cleanly.
 */
async function httpGet<T>(
	server: string,
	path: string,
	options: { retries?: number; retryDelayMs?: number } = {},
): Promise<T> {
	const retries = options.retries ?? 3;
	const retryDelay = options.retryDelayMs ?? 500;
	let lastError: unknown = null;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${server}${path}`);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`GET ${path} -> ${res.status}: ${text}`);
			}
			return (await res.json()) as T;
		} catch (e) {
			lastError = e;
			const msg = (e as Error).message ?? "";
			const retriable =
				msg === "fetch failed" ||
				msg.includes("ECONNRESET") ||
				msg.includes("UND_ERR_SOCKET") ||
				msg.includes("terminated");
			if (!retriable || attempt === retries) break;
			await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error(`GET ${path} failed: ${String(lastError)}`);
}

async function httpPost<T>(
	server: string,
	path: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`${server}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const payload = (await res.json().catch(() => ({}))) as T;
	if (!res.ok) {
		throw new Error(
			`POST ${path} -> ${res.status}: ${JSON.stringify(payload)}`,
		);
	}
	return payload;
}

async function httpDelete(server: string, path: string): Promise<void> {
	const res = await fetch(`${server}${path}`, { method: "DELETE" });
	if (!res.ok) {
		throw new Error(`DELETE ${path} -> ${res.status}`);
	}
}

/** Outcome summary from an SSE POST, returned instead of throwing on soft failures. */
interface SsePostOutcome {
	executionCompleted: boolean;
	terminated: boolean;
	terminatedReason?: string;
	eventCount: number;
}

/**
 * POST to an SSE endpoint, parse each event, invoke `onEvent` for every
 * parsed payload, and return an outcome summary when `execution.completed`
 * arrives, the stream closes, or the timeout fires. The server envelope
 * wraps the actual event under `payload`, matching makeEnvelope() in
 * apps/server/src/routes/api/actions.ts.
 *
 * Soft failures (upstream socket termination, premature EOF) are caught
 * and surfaced via the returned outcome rather than thrown — the caller
 * can still read whatever the backend committed to the turn record.
 * Infrastructure failures (DNS, HTTP 4xx/5xx, timeout) still throw.
 */
async function httpPostSse(
	server: string,
	path: string,
	body: unknown,
	onEvent: (evt: SseEvent) => void,
	timeoutSec: number,
): Promise<SsePostOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
	const outcome: SsePostOutcome = {
		executionCompleted: false,
		terminated: false,
		eventCount: 0,
	};

	try {
		const res = await fetch(`${server}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`POST ${path} -> ${res.status}: ${text}`);
		}
		if (!res.body) return outcome;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const raw = line.slice(6);
					try {
						const parsed = JSON.parse(raw) as {
							type?: string;
							payload?: Record<string, unknown>;
						};
						const type = parsed.type ?? "unknown";
						const payload = parsed.payload ?? {};
						onEvent({ type, payload });
						outcome.eventCount++;
						if (type === "execution.completed") {
							outcome.executionCompleted = true;
							reader.cancel().catch(() => {});
							return outcome;
						}
						if (type === "error.occurred") {
							const msg = String(payload.message ?? "unknown error");
							throw new Error(`server-side error: ${msg}`);
						}
					} catch (e) {
						if ((e as Error).message?.startsWith("server-side error")) throw e;
						// Silently skip malformed lines; the server occasionally inserts
						// keepalive/comment lines that are not valid JSON data.
					}
				}
			}
		} catch (readError) {
			// undici raises `TypeError: terminated` when the upstream socket dies
			// mid-stream (e.g. LLM provider keep-alive timeout, rate limit, or
			// crash). We don't want a partial failure in one turn to kill the
			// entire test run — surface it to the caller so the next turn can
			// still run and the final report can still be written.
			const err = readError as Error & { cause?: { code?: string } };
			const msg = err.message ?? "";
			const causeCode = err.cause?.code ?? "";
			const isTermination =
				msg === "terminated" ||
				msg.includes("terminated") ||
				causeCode === "UND_ERR_SOCKET" ||
				causeCode === "ECONNRESET";
			if (isTermination) {
				outcome.terminated = true;
				outcome.terminatedReason = `${msg || causeCode || "unknown socket termination"}`;
				return outcome;
			}
			throw readError;
		}
		return outcome;
	} catch (e) {
		if ((e as Error).name === "AbortError") {
			throw new Error(`SSE timeout after ${timeoutSec}s on ${path}`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

// ──────────────────────────────────────────────────────────────────
// Log sink — tees every console.log/error to a file under --log-dir.
// The sink is installed before any output so the log captures the
// full run, including the Phase 1 header. Nothing outside console.log
// / console.error is touched; tool output / error traces all funnel
// through those two surfaces already.
// ──────────────────────────────────────────────────────────────────

interface LogSink {
	stream: WriteStream;
	logPath: string;
	artefactDir: string;
	timestamp: string;
	close(): void;
}

function formatTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

function installLogSink(logDir: string): LogSink {
	const timestamp = formatTimestamp(new Date());
	const absDir = resolvePath(process.cwd(), logDir);
	mkdirSync(absDir, { recursive: true });

	const logPath = resolvePath(absDir, `e2e-${timestamp}.log`);
	const stream = createWriteStream(logPath, { flags: "w" });

	const origLog = console.log.bind(console);
	const origErr = console.error.bind(console);

	const write = (...parts: unknown[]): void => {
		try {
			const text = parts
				.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
				.join(" ");
			stream.write(text);
			stream.write("\n");
		} catch {
			// Never let log-persistence errors abort the run.
		}
	};

	console.log = (...args: unknown[]) => {
		origLog(...args);
		write(...args);
	};
	console.error = (...args: unknown[]) => {
		origErr(...args);
		write(...args);
	};

	return {
		stream,
		logPath,
		artefactDir: absDir,
		timestamp,
		close: () => {
			try {
				stream.end();
			} catch {
				/* ignore */
			}
			console.log = origLog;
			console.error = origErr;
		},
	};
}

/** Write a JSON artefact next to the log file; errors are non-fatal. */
function saveArtefact(
	sink: LogSink | null,
	name: string,
	value: unknown,
): string | null {
	if (!sink) return null;
	try {
		const path = resolvePath(
			sink.artefactDir,
			`e2e-${sink.timestamp}-${name}.json`,
		);
		writeFileSync(path, JSON.stringify(value, null, 2));
		return path;
	} catch (e) {
		console.error(`  WARNING: failed to save ${name}: ${(e as Error).message}`);
		return null;
	}
}

// ──────────────────────────────────────────────────────────────────
// Output helpers — plain text, fixed-width tables, no colour/emoji
// ──────────────────────────────────────────────────────────────────

const HR = "=".repeat(80);
const DIV = "-".repeat(80);

function header(title: string): void {
	console.log("");
	console.log(HR);
	console.log(title);
	console.log(HR);
}

function section(title: string): void {
	console.log("");
	console.log(title);
	console.log(DIV);
}

function kv(key: string, value: unknown, width = 14): void {
	const paddedKey = key.padEnd(width);
	console.log(`  ${paddedKey}: ${value}`);
}

function printTable(headers: string[], rows: string[][]): void {
	if (rows.length === 0) {
		console.log("  (empty)");
		return;
	}
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
	);
	const fmt = (cells: string[]) =>
		cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
	console.log("  " + fmt(headers));
	console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) console.log("  " + fmt(row));
}

function summariseOutput(output: Record<string, unknown> | undefined): string {
	if (!output) return "-";
	const parts: string[] = [];
	if (
		typeof output.narrativeOutput === "string" &&
		output.narrativeOutput.length > 0
	) {
		parts.push(`narrative(${output.narrativeOutput.length}c)`);
	}
	const interactions = Array.isArray(output.interactions)
		? output.interactions.length
		: 0;
	if (interactions > 0) parts.push(`interactions=${interactions}`);
	if (typeof output.form === "object" && output.form !== null)
		parts.push("form");
	if (typeof output.playerCreated === "boolean")
		parts.push(`playerCreated=${output.playerCreated}`);
	if (Array.isArray(output.categories))
		parts.push(`categories=${output.categories.length}`);
	if (typeof output.npcContext === "string" && output.npcContext.length > 0) {
		parts.push(`npcCtx(${output.npcContext.length}c)`);
	}
	if (parts.length === 0) {
		const keys = Object.keys(output);
		if (keys.length > 0)
			parts.push(
				`keys=[${keys.slice(0, 3).join(",")}${keys.length > 3 ? "..." : ""}]`,
			);
	}
	return parts.length > 0 ? parts.join(" ") : "-";
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function previewJson(value: unknown, max = 80): string {
	try {
		const s = JSON.stringify(value);
		return truncate(s, max);
	} catch {
		return "<unserializable>";
	}
}

// ──────────────────────────────────────────────────────────────────
// Trigger expectation computation (mirrors packages/runtime/src/trigger.ts)
// ──────────────────────────────────────────────────────────────────

interface TriggerState {
	triggerCount: number;
	lastTriggerTurnNumber: number | null;
}

interface TriggerExpectation {
	expected: boolean;
	reason: string;
}

/**
 * Compute whether a runtime should have triggered given the framework's
 * trigger rules. This mirrors packages/runtime/src/trigger.ts. The plugin
 * flow metadata from /api/plugin-flows drives this check, so it adapts
 * automatically when plugins are added or modified.
 *
 * Band filtering (priority 0-99 Pre-Game vs 100-1000 main loop) is handled
 * server-side by the scheduler based on `session.turnCount`. The script
 * does not re-validate the band — it only checks trigger rules that remain
 * in the manifest (interval, cooldown, maxTriggerCount, startTurn).
 */
function computeExpectation(
	step: PluginFlowStep,
	turnNumber: number,
	playingTurnNumber: number,
	state: TriggerState,
): TriggerExpectation {
	const t = step.trigger;

	// PR-2: startTurn is compared against playingTurnNumber, not turnNumber.
	if (t.startTurn !== undefined && playingTurnNumber < t.startTurn) {
		return {
			expected: false,
			reason: `startTurn(${t.startTurn}) not reached (playingTurn=${playingTurnNumber})`,
		};
	}

	if (
		t.maxTriggerCount !== undefined &&
		state.triggerCount >= t.maxTriggerCount
	) {
		return {
			expected: false,
			reason: `maxTriggerCount(${t.maxTriggerCount}) reached`,
		};
	}

	const turnsSince =
		state.lastTriggerTurnNumber !== null
			? turnNumber - state.lastTriggerTurnNumber
			: Number.POSITIVE_INFINITY;

	if (t.cooldownTurns !== undefined && turnsSince < t.cooldownTurns) {
		return {
			expected: false,
			reason: `cooldown: turnsSince=${turnsSince}<cd=${t.cooldownTurns}`,
		};
	}

	if (t.type === "auto") {
		return { expected: true, reason: "auto" };
	}

	if (t.type === "scheduled") {
		const interval = t.interval ?? 1;
		const hits = turnNumber % interval === 0;
		return {
			expected: hits,
			reason: hits
				? `scheduled interval=${interval}`
				: `turnNumber(${turnNumber})%${interval}≠0`,
		};
	}

	return { expected: false, reason: `unknown trigger type: ${t.type}` };
}

// ──────────────────────────────────────────────────────────────────
// Form auto-fill from runtime result
// ──────────────────────────────────────────────────────────────────

interface DetectedForm {
	turnId: string;
	runtimeId: string;
	interactionId: string;
	fields: Array<{
		name: string;
		type: string;
		required?: boolean;
		options?: Array<string | { value?: string; label?: string }>;
	}>;
}

/**
 * Walk a turn's runtime results looking for an unhandled `form` interaction
 * produced by a plugin. Returns the first one found, or null.
 */
function detectFormInTurn(
	turnId: string,
	runtimeResults: RuntimeResultRecord[],
): DetectedForm | null {
	for (const rt of runtimeResults) {
		const output = rt.output;
		if (!output) continue;

		// Path 1: output.interactions[] with type='form'
		const interactions = Array.isArray(output.interactions)
			? output.interactions
			: [];
		for (const interaction of interactions) {
			if (!interaction || typeof interaction !== "object") continue;
			const obj = interaction as Record<string, unknown>;
			if (obj.type === "form") {
				return toDetectedForm(turnId, rt.runtimeId, obj);
			}
		}

		// Path 2: output.form (legacy single-form shape)
		if (output.form && typeof output.form === "object") {
			return toDetectedForm(
				turnId,
				rt.runtimeId,
				output.form as Record<string, unknown>,
			);
		}

		// Path 3: create-form tool call input (fallback if output doesn't carry
		// the form but the tool call does)
		for (const tc of rt.toolCalls ?? []) {
			if (tc.toolName !== "create-form") continue;
			if (tc.input && typeof tc.input === "object") {
				return toDetectedForm(
					turnId,
					rt.runtimeId,
					tc.input as Record<string, unknown>,
				);
			}
		}
	}
	return null;
}

function toDetectedForm(
	turnId: string,
	runtimeId: string,
	source: Record<string, unknown>,
): DetectedForm {
	const rawFields = Array.isArray(source.fields) ? source.fields : [];
	const fields = rawFields
		.filter(
			(f): f is Record<string, unknown> => typeof f === "object" && f !== null,
		)
		.map((f) => ({
			name: String(f.name ?? f.id ?? ""),
			type: String(f.type ?? "text"),
			required: f.required === true,
			options: Array.isArray(f.options)
				? (f.options as Array<string | { value?: string; label?: string }>)
				: undefined,
		}))
		.filter((f) => f.name.length > 0);

	return {
		turnId,
		runtimeId,
		interactionId: String(
			source.interactionId ?? source.formId ?? source.id ?? "form",
		),
		fields,
	};
}

/**
 * Materialise form values from user overrides + heuristic defaults.
 * Missing required fields are filled with placeholder data derived from
 * the field type so the submission always satisfies the schema.
 */
function buildFormValues(
	form: DetectedForm,
	overrides: Record<string, string>,
): Record<string, string> {
	const values: Record<string, string> = {};

	for (const field of form.fields) {
		if (overrides[field.name] !== undefined) {
			values[field.name] = overrides[field.name];
			continue;
		}
		if (field.type === "select" && field.options && field.options.length > 0) {
			const first = field.options[0];
			values[field.name] =
				typeof first === "string"
					? first
					: String(first?.value ?? first?.label ?? "");
			continue;
		}
		if (field.type === "text" || field.type === "textarea") {
			values[field.name] =
				field.name === "characterName" ? "E2E测试角色" : `测试${field.name}`;
			continue;
		}
		values[field.name] = "";
	}

	// Safety net: at least characterName for auto-advanced flows that
	// skipped fields we didn't understand.
	if (Object.keys(values).length === 0) {
		values.characterName = overrides.characterName ?? "E2E测试角色";
	}

	return values;
}

// ──────────────────────────────────────────────────────────────────
// Turn execution
// ──────────────────────────────────────────────────────────────────

interface TurnExecution {
	turnRecord: TurnRecord;
	sseEvents: SseEvent[];
	elapsedMs: number;
	terminated: boolean;
	terminatedReason?: string;
}

/**
 * Post an action, consume the SSE stream, and return the turn record
 * freshly fetched from /sessions/:id/turns. Soft stream terminations
 * (upstream LLM disconnects) are surfaced in the returned record so
 * the test can continue; the backend may still have committed a
 * partial turn that's worth inspecting.
 */
async function runTurn(
	args: CliArgs,
	sessionId: string,
	action: { type: string; payload: Record<string, unknown> },
): Promise<TurnExecution> {
	const started = Date.now();
	const sseEvents: SseEvent[] = [];

	const body: Record<string, unknown> = {
		sessionId,
		type: action.type,
		payload: action.payload,
		requestId: randomUUID(),
		locale: "zh-CN",
	};
	if (args.slot) body.model = args.slot;

	const outcome = await httpPostSse(
		args.server,
		"/actions",
		body,
		(evt) => {
			sseEvents.push(evt);
			if (args.verbose) {
				const preview = previewJson(evt.payload, 100);
				console.log(`  [sse] ${evt.type.padEnd(22)} ${preview}`);
			}
		},
		args.timeoutSec,
	);

	const elapsedMs = Date.now() - started;

	if (outcome.terminated) {
		console.log(
			`  WARNING: SSE stream terminated prematurely (${outcome.terminatedReason ?? "unknown"}) — ` +
				`collected ${outcome.eventCount} events; reading turn record from store`,
		);
	}

	// Settle window: normally 300ms is enough for the commit pipeline to
	// flush. After a terminated SSE we wait longer so undici has time to
	// reap the broken keep-alive socket from its connection pool before
	// the next fetch reuses it.
	await new Promise((r) => setTimeout(r, outcome.terminated ? 1500 : 300));

	// Pull the latest turn from the authoritative source
	const turnsResp = await httpGet<{ turns: TurnRecord[] }>(
		args.server,
		`/sessions/${sessionId}/turns`,
	);
	const turns = turnsResp.turns ?? [];
	if (turns.length === 0) {
		throw new Error("No turns returned from /turns after action");
	}
	const turnRecord = turns[turns.length - 1];

	return {
		turnRecord,
		sseEvents,
		elapsedMs,
		terminated: outcome.terminated,
		terminatedReason: outcome.terminatedReason,
	};
}

// ──────────────────────────────────────────────────────────────────
// Per-turn reporting
// ──────────────────────────────────────────────────────────────────

interface PerTurnContext {
	turnNumber: number;
	/**
	 * Playing-phase turn counter (PR-2). Mirrors server-side semantics:
	 * 0-based from the first turn that runs after the Pre-Game band ends
	 * (i.e. once `session.turnCount >= 1`). Reset back to 0 if session
	 * rewinds to Pre-Game (turnCount === 0).
	 */
	playingTurnNumber: number;
	/** Mirrors `session.turnCount` — 0 for Pre-Game band, >=1 for main loop. */
	turnCount: number;
	/** Mirrors `session.status` — 'active' | 'paused' | 'ended'. */
	status: string;
	flow: PluginFlowResponse;
	triggerStates: Map<string, TriggerState>;
	assertions: Assertions;
	runtimeFilter?: string;
	pluginFilter?: string;
}

function runtimePasses(
	step: PluginFlowStep,
	filterRuntime?: string,
	filterPlugin?: string,
): boolean {
	if (filterRuntime && step.runtimeId !== filterRuntime) return false;
	if (filterPlugin && step.pluginId !== filterPlugin) return false;
	return true;
}

function reportTurn(ctx: PerTurnContext, exec: TurnExecution): void {
	const { turnRecord, elapsedMs } = exec;
	const ran = new Map(
		turnRecord.runtimeResults.map((r) => [r.runtimeId, r] as const),
	);

	// ── Runtime timeline ──────────────────────────────────────────
	console.log("");
	console.log(`  TurnId: ${turnRecord.turnId}`);
	console.log(`  Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

	const timelineRows: string[][] = [];
	const orderedSteps = [...ctx.flow.steps].sort(
		(a, b) => a.priority - b.priority,
	);

	for (const step of orderedSteps) {
		if (!runtimePasses(step, ctx.runtimeFilter, ctx.pluginFilter)) continue;
		const rt = ran.get(step.runtimeId);
		if (!rt) continue;
		timelineRows.push([
			String(step.priority),
			step.runtimeId,
			rt.status,
			`${(rt.durationMs / 1000).toFixed(1)}s`,
			summariseOutput(rt.output),
		]);
	}

	// Include ran-but-not-in-flow runtimes (sub-runtimes discovered after flow fetch)
	for (const rt of turnRecord.runtimeResults) {
		const inFlow = ctx.flow.steps.some((s) => s.runtimeId === rt.runtimeId);
		if (inFlow) continue;
		if (ctx.runtimeFilter && rt.runtimeId !== ctx.runtimeFilter) continue;
		if (ctx.pluginFilter && rt.pluginId !== ctx.pluginFilter) continue;
		timelineRows.push([
			"?",
			rt.runtimeId,
			rt.status,
			`${(rt.durationMs / 1000).toFixed(1)}s`,
			summariseOutput(rt.output),
		]);
	}

	console.log("");
	console.log("  Runtime Timeline:");
	printTable(["pri", "runtime", "status", "dur", "output"], timelineRows);

	// ── Tool calls ─────────────────────────────────────────────────
	const toolCallRows: string[][] = [];
	let totalToolCalls = 0;
	for (const rt of turnRecord.runtimeResults) {
		if (ctx.runtimeFilter && rt.runtimeId !== ctx.runtimeFilter) continue;
		if (ctx.pluginFilter && rt.pluginId !== ctx.pluginFilter) continue;
		for (const tc of rt.toolCalls ?? []) {
			totalToolCalls++;
			const status = tc.status ?? "success";
			const duration =
				typeof tc.durationMs === "number" ? `${tc.durationMs}ms` : "-";
			const approval = tc.approvalStatus ?? "-";
			toolCallRows.push([
				rt.runtimeId,
				tc.toolName ?? "?",
				status,
				duration,
				approval,
				previewJson(tc.input, 60),
				previewJson(tc.output, 60),
			]);
		}
	}
	console.log("");
	console.log(`  Tool Calls (${totalToolCalls} total):`);
	printTable(
		["runtime", "tool", "status", "dur", "approval", "input", "output"],
		toolCallRows,
	);

	// ── Trigger verification ──────────────────────────────────────
	console.log("");
	console.log("  Trigger Verification:");
	const triggerRows: string[][] = [];
	for (const step of orderedSteps) {
		if (!runtimePasses(step, ctx.runtimeFilter, ctx.pluginFilter)) continue;
		const state = ctx.triggerStates.get(step.runtimeId) ?? {
			triggerCount: 0,
			lastTriggerTurnNumber: null,
		};
		const expectation = computeExpectation(
			step,
			ctx.turnNumber,
			ctx.playingTurnNumber,
			state,
		);
		const ranIt = ran.has(step.runtimeId);

		let verdict: string;
		if (expectation.expected && ranIt) {
			const rt = ran.get(step.runtimeId)!;
			if (rt.status === "success" || rt.status === "completed") {
				verdict = "PASS";
				ctx.assertions.pass(`${step.runtimeId} triggered`);
			} else {
				verdict = "FAIL";
				ctx.assertions.fail(`${step.runtimeId} ran with status=${rt.status}`);
			}
		} else if (!expectation.expected && !ranIt) {
			verdict = "SKIP";
		} else if (expectation.expected && !ranIt) {
			verdict = "FAIL";
			ctx.assertions.fail(
				`${step.runtimeId} should have triggered (${expectation.reason})`,
			);
		} else {
			verdict = "FAIL";
			ctx.assertions.fail(
				`${step.runtimeId} ran but was not expected (${expectation.reason})`,
			);
		}

		triggerRows.push([
			verdict,
			step.runtimeId,
			expectation.expected ? "yes" : "no",
			ranIt ? "yes" : "no",
			expectation.reason,
		]);
	}
	printTable(
		["result", "runtime", "expected", "actual", "reason"],
		triggerRows,
	);

	// ── Update trigger state for next turn ─────────────────────────
	for (const rt of turnRecord.runtimeResults) {
		if (rt.status !== "success" && rt.status !== "completed") continue;
		const s = ctx.triggerStates.get(rt.runtimeId) ?? {
			triggerCount: 0,
			lastTriggerTurnNumber: null,
		};
		ctx.triggerStates.set(rt.runtimeId, {
			triggerCount: s.triggerCount + 1,
			lastTriggerTurnNumber: ctx.turnNumber,
		});
	}
}

// ──────────────────────────────────────────────────────────────────
// Assertion accumulator
// ──────────────────────────────────────────────────────────────────

class Assertions {
	passed = 0;
	failed = 0;
	warnings = 0;
	readonly failures: string[] = [];
	readonly warningMessages: string[] = [];

	pass(_label: string): void {
		this.passed++;
	}
	fail(label: string): void {
		this.failed++;
		this.failures.push(label);
	}
	warn(label: string): void {
		this.warnings++;
		this.warningMessages.push(label);
	}
}

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

interface MainState {
	sessionId: string | null;
	finalTurns: TurnRecord[];
	snapshot: unknown;
	pass: boolean;
	fatalError: Error | null;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	// Install log sink before any output so the persisted file mirrors
	// the full run. --no-log skips this entirely.
	const sink: LogSink | null = args.logEnabled
		? installLogSink(args.logDir)
		: null;

	const state: MainState = {
		sessionId: null,
		finalTurns: [],
		snapshot: null,
		pass: false,
		fatalError: null,
	};

	try {
		await runMain(args, sink, state);
	} catch (e) {
		state.fatalError = e as Error;
		console.error("");
		console.error(`FATAL: ${(e as Error).message}`);
		if ((e as Error).stack) console.error((e as Error).stack);
	} finally {
		// Save artefacts even on fatal error so operators can diagnose.
		if (sink && state.sessionId) {
			if (state.finalTurns.length === 0) {
				try {
					const resp = await httpGet<{ turns: TurnRecord[] }>(
						args.server,
						`/sessions/${state.sessionId}/turns`,
					);
					state.finalTurns = resp.turns ?? [];
				} catch {
					/* backend unreachable — artefact will be empty */
				}
			}
			saveArtefact(sink, `${state.sessionId}-turns`, state.finalTurns);
			if (state.snapshot) {
				saveArtefact(sink, `${state.sessionId}-snapshot`, state.snapshot);
			}
			const failedRuntimes = state.finalTurns.flatMap((t) =>
				t.runtimeResults
					.filter((r) => r.status === "failed")
					.map((r) => ({
						turnId: t.turnId,
						runtimeId: r.runtimeId,
						pluginId: r.pluginId,
						error: (r as unknown as Record<string, unknown>).error ?? null,
						durationMs: r.durationMs,
					})),
			);
			if (failedRuntimes.length > 0) {
				saveArtefact(sink, `${state.sessionId}-failures`, failedRuntimes);
			}
			if (state.fatalError) {
				saveArtefact(sink, `${state.sessionId}-fatal`, {
					message: state.fatalError.message,
					stack: state.fatalError.stack,
				});
			}
			console.log("");
			console.log("  Artefacts:");
			console.log(`    log:      ${sink.logPath}`);
			console.log(
				`    (turns / snapshot / failures / fatal written next to the log)`,
			);
		} else if (sink) {
			console.log("");
			console.log(
				`  Artefacts: log only (no session created) — ${sink.logPath}`,
			);
		}

		if (sink) sink.close();
	}

	process.exit(state.pass ? 0 : 1);
}

async function runMain(
	args: CliArgs,
	sink: LogSink | null,
	state: MainState,
): Promise<void> {
	header("Covel E2E Plugin Verification");
	kv("Server", args.server);
	kv("Slot", args.slot);
	kv("Turns", args.turns);
	kv("Runtime filter", args.runtimeFilter ?? "(none)");
	kv("Plugin filter", args.pluginFilter ?? "(none)");
	kv("Timeout", `${args.timeoutSec}s`);
	kv("Timestamp", new Date().toISOString());
	if (sink) kv("Log file", sink.logPath);

	const assertions = new Assertions();

	// ── Phase 1: Health ────────────────────────────────────────────
	section("Phase 1: Health Check");
	try {
		const health = await httpGet<{
			status: string;
			storeBackend: string;
			bootId: string;
		}>(args.server, "/health");
		kv("Status", health.status);
		kv("Store backend", health.storeBackend);
		kv("Boot ID", health.bootId);
		if (health.status !== "ok") {
			assertions.fail("Server health not ok");
		}
	} catch (e) {
		console.log(`  ERROR: cannot reach server — ${(e as Error).message}`);
		console.log("  Start it with: pnpm dev:server");
		process.exit(2);
	}

	// ── Phase 2: Plugin flow discovery ─────────────────────────────
	section("Phase 2: Plugin Flow Discovery");
	const flow = await httpGet<PluginFlowResponse>(args.server, "/plugin-flows");
	kv("Plugins", flow.plugins.length);
	kv("Runtimes", flow.steps.length);

	for (const seg of flow.segments) {
		const segSteps = flow.steps.filter(
			(s) => s.priority >= seg.minPriority && s.priority <= seg.maxPriority,
		);
		if (segSteps.length === 0) continue;
		console.log("");
		console.log(`  ${seg.label} [priority ${seg.rangeLabel}]`);
		const rows = segSteps
			.sort((a, b) => a.priority - b.priority)
			.map((s) => [
				String(s.priority),
				s.runtimeId,
				s.runtimeType,
				s.outputKind,
				formatTrigger(s.trigger),
			]);
		printTable(["pri", "runtime", "type", "output", "trigger"], rows);
	}

	if (args.runtimeFilter) {
		const exists = flow.steps.some((s) => s.runtimeId === args.runtimeFilter);
		if (!exists) {
			console.log(
				`  WARNING: --runtime ${args.runtimeFilter} not in flow (continuing)`,
			);
			assertions.warn(`runtime ${args.runtimeFilter} not discovered`);
		}
	}
	if (args.pluginFilter) {
		const exists = flow.plugins.some((p) => p.id === args.pluginFilter);
		if (!exists) {
			console.log(
				`  WARNING: --plugin ${args.pluginFilter} not in flow (continuing)`,
			);
			assertions.warn(`plugin ${args.pluginFilter} not discovered`);
		}
	}

	// ── Phase 3: World selection ───────────────────────────────────
	section("Phase 3: World Selection");
	const worldsResp = await httpGet<{
		items: Array<{ id: string; name?: unknown }>;
	}>(args.server, "/worlds");
	const worlds = worldsResp.items ?? [];
	if (worlds.length === 0) {
		console.log("  ERROR: no worlds available");
		process.exit(2);
	}
	const chosen = args.world
		? worlds.find((w) => w.id === args.world)
		: worlds[0];
	if (!chosen) {
		console.log(`  ERROR: world '${args.world}' not found`);
		process.exit(2);
	}
	kv("World", chosen.id);

	// ── Phase 4: Session creation ──────────────────────────────────
	section("Phase 4: Session Creation");
	const session = await httpPost<SessionRecord>(args.server, "/sessions", {
		worldId: chosen.id,
		locale: "zh-CN",
	});
	state.sessionId = session.id;
	kv("Session ID", session.id);
	kv("Status", session.status);
	kv("Turn count", session.turnCount);

	// ── Phase 5: Turn execution ────────────────────────────────────
	section("Phase 5: Turn Execution");

	const triggerStates = new Map<string, TriggerState>();
	for (const step of flow.steps) {
		triggerStates.set(step.runtimeId, {
			triggerCount: 0,
			lastTriggerTurnNumber: null,
		});
	}

	// Mirrors server semantics: once the session first leaves the Pre-Game
	// band (turnCount advances from 0 → 1), remember the script's own
	// turnNumber at that moment and use it as the origin for
	// playingTurnNumber from then on.
	let playingTurnOrigin: number | null = null;

	const ctx: PerTurnContext = {
		turnNumber: 0,
		playingTurnNumber: 0,
		turnCount: session.turnCount,
		status: session.status,
		flow,
		triggerStates,
		assertions,
		runtimeFilter: args.runtimeFilter,
		pluginFilter: args.pluginFilter,
	};

	function refreshPlayingTurn(): void {
		if (ctx.turnCount >= 1) {
			if (playingTurnOrigin === null) playingTurnOrigin = ctx.turnNumber;
			ctx.playingTurnNumber = Math.max(0, ctx.turnNumber - playingTurnOrigin);
		} else {
			ctx.playingTurnNumber = 0;
		}
	}

	function bandLabel(): string {
		return ctx.turnCount === 0 ? "pre-game" : "playing";
	}

	// Turn 1: start_session
	refreshPlayingTurn();
	console.log("");
	console.log(
		`  Turn ${ctx.turnNumber + 1}: start_session (band=${bandLabel()}, turnCount=${ctx.turnCount})`,
	);
	console.log(DIV);
	let exec = await runTurn(args, session.id, {
		type: "start_session",
		payload: {},
	});
	reportTurn(ctx, exec);

	// Advance turn counter
	ctx.turnNumber += 1;

	// Auto form handling: detect a form in turn 1 results, submit it,
	// and post send_message to advance past character creation.
	const detectedForm = detectFormInTurn(
		exec.turnRecord.turnId,
		exec.turnRecord.runtimeResults,
	);
	if (detectedForm) {
		console.log("");
		console.log("  Detected interaction form:");
		kv("Runtime", detectedForm.runtimeId);
		kv("Interaction", detectedForm.interactionId);
		kv(
			"Fields",
			detectedForm.fields
				.map((f) => `${f.name}(${f.type}${f.required ? "*" : ""})`)
				.join(", ") || "(none)",
		);

		const values = buildFormValues(detectedForm, args.formValues);
		kv("Values", previewJson(values, 120));

		const submitResp = await httpPost<{
			filledNarrative?: string;
			results?: unknown;
		}>(args.server, `/sessions/${session.id}/submit-inputs`, {
			turnId: detectedForm.turnId,
			submissions: [
				{
					interactionId: detectedForm.interactionId,
					type: "form",
					values,
				},
			],
		});
		const filled = submitResp.filledNarrative ?? "";
		if (filled) kv("Filled narrative", truncate(filled, 80));

		// Refresh band from server — the submit-inputs + turn commit chain may
		// have advanced session.turnCount past Pre-Game already.
		const sessAfterSubmit = await httpGet<SessionRecord>(
			args.server,
			`/sessions/${session.id}`,
		);
		ctx.turnCount = sessAfterSubmit.turnCount;
		ctx.status = sessAfterSubmit.status;
		refreshPlayingTurn();

		console.log("");
		console.log(
			`  Turn ${ctx.turnNumber + 1}: send_message (after form submit, band=${bandLabel()}, turnCount=${ctx.turnCount})`,
		);
		console.log(DIV);
		exec = await runTurn(args, session.id, {
			type: "send_message",
			payload: { content: filled || "继续" },
		});
		reportTurn(ctx, exec);
		ctx.turnNumber += 1;
	}

	// Remaining playing-band turns
	const sess = await httpGet<SessionRecord>(
		args.server,
		`/sessions/${session.id}`,
	);
	ctx.turnCount = sess.turnCount;
	ctx.status = sess.status;
	refreshPlayingTurn();

	const defaultPlayerMessages = [
		"探索周围环境，寻找任何可以利用的线索。",
		"与同伴交流，分享彼此的判断和下一步的打算。",
		"小心靠近目标区域，保持警觉地观察环境。",
		"尝试回忆此前发生过的事件，看看是否能关联起来。",
		"根据掌握的信息做出谨慎的决定，然后继续前进。",
	];

	for (let i = 0; i < args.turns; i++) {
		const content =
			args.playerMessage ??
			defaultPlayerMessages[i % defaultPlayerMessages.length];
		console.log("");
		console.log(
			`  Turn ${ctx.turnNumber + 1}: send_message #${i + 1} (band=${bandLabel()}, turnCount=${ctx.turnCount})`,
		);
		console.log(DIV);
		console.log(`  Player: ${truncate(content, 72)}`);

		exec = await runTurn(args, session.id, {
			type: "send_message",
			payload: { content },
		});
		reportTurn(ctx, exec);
		ctx.turnNumber += 1;

		// Refresh band for next turn's trigger check
		const fresh = await httpGet<SessionRecord>(
			args.server,
			`/sessions/${session.id}`,
		);
		ctx.turnCount = fresh.turnCount;
		ctx.status = fresh.status;
		refreshPlayingTurn();
	}

	// ── Phase 6: Final snapshot ────────────────────────────────────
	section("Phase 6: Final Session Snapshot");
	const snapshot = await httpGet<{
		session: SessionRecord;
		messages?: unknown[];
		characters?: unknown[];
		plugins?: Array<{ id: string; isActive: boolean }>;
	}>(args.server, `/sessions/${session.id}/snapshot`);
	state.snapshot = snapshot;
	kv("Session ID", snapshot.session.id);
	kv("Status", snapshot.session.status);
	kv("Turn count", snapshot.session.turnCount);
	kv("Messages", snapshot.messages?.length ?? 0);
	kv("Characters", snapshot.characters?.length ?? 0);
	kv("Active plugins", snapshot.plugins?.filter((p) => p.isActive).length ?? 0);

	// Trace coverage assertion: confirm the core trace types expected to fire
	// on every happy-path turn are being emitted. Negative / conditional
	// signals (`tool.failed`, `hook.aborted`, `hook.rewrote`) intentionally
	// stay out of REQUIRED_TYPES — they are only emitted on specific branches.
	// `args.server` already contains the `/api` prefix (default
	// http://localhost:3001/api), so we use the relative `/traces/...` path.
	const tracesBody = await httpGet<{ events: Array<{ type: string }> }>(
		args.server,
		`/traces/${encodeURIComponent(session.id)}`,
	);
	const seenTypes = new Set(tracesBody.events.map((e) => e.type));
	const REQUIRED_TYPES = [
		"turn.started",
		"runtime.started",
		"runtime.completed",
		"proposal.committed",
		"tool.calling",
		"tool.completed",
		"llm.calling",
		"llm.responded",
		"message.completed",
		"block.emitted",
		"hook.fired",
	];
	const missing = REQUIRED_TYPES.filter((t) => !seenTypes.has(t));
	if (missing.length > 0) {
		console.error(`[e2e] missing expected trace types: ${missing.join(", ")}`);
		console.error(
			`[e2e] seen types: ${Array.from(seenTypes).sort().join(", ")}`,
		);
		process.exit(1);
	}
	console.log(
		`[e2e] trace type coverage OK (${seenTypes.size} distinct types)`,
	);

	// ── Phase 7: Summary ───────────────────────────────────────────
	section("Phase 7: Summary");
	const turnsResp = await httpGet<{ turns: TurnRecord[] }>(
		args.server,
		`/sessions/${session.id}/turns`,
	);
	const allTurns = turnsResp.turns ?? [];
	state.finalTurns = allTurns;

	let totalRunRuns = 0;
	let successRuns = 0;
	let failRuns = 0;
	let skippedRuns = 0;
	let totalToolCalls = 0;
	let successToolCalls = 0;
	let failToolCalls = 0;

	for (const t of allTurns) {
		for (const rt of t.runtimeResults) {
			totalRunRuns++;
			if (rt.status === "success" || rt.status === "completed") successRuns++;
			else if (rt.status === "failed") failRuns++;
			else if (rt.status === "skipped") skippedRuns++;
			for (const tc of rt.toolCalls ?? []) {
				totalToolCalls++;
				if (tc.status === "failed") failToolCalls++;
				else successToolCalls++;
			}
		}
	}

	kv("Total turns", allTurns.length);
	kv(
		"Runtime runs",
		`${totalRunRuns} (ok=${successRuns} fail=${failRuns} skip=${skippedRuns})`,
	);
	kv(
		"Tool calls",
		`${totalToolCalls} (ok=${successToolCalls} fail=${failToolCalls})`,
	);
	kv(
		"Assertions",
		`pass=${assertions.passed} fail=${assertions.failed} warn=${assertions.warnings}`,
	);

	if (assertions.failures.length > 0) {
		console.log("");
		console.log("  Failures:");
		for (const failure of assertions.failures) {
			console.log(`    - ${failure}`);
		}
	}
	if (assertions.warningMessages.length > 0) {
		console.log("");
		console.log("  Warnings:");
		for (const w of assertions.warningMessages) {
			console.log(`    - ${w}`);
		}
	}

	const pass = assertions.failed === 0 && failRuns === 0 && failToolCalls === 0;
	state.pass = pass;
	console.log("");
	console.log(`  RESULT: ${pass ? "PASS" : "FAIL"}`);

	// ── Cleanup ────────────────────────────────────────────────────
	// Artefact persistence happens in the top-level `main()` finally
	// block so it runs on every exit path, including fatal errors.
	if (!args.keep) {
		if (pass) {
			try {
				await httpDelete(args.server, `/sessions/${session.id}`);
				kv("Cleanup", `session ${session.id} deleted`);
			} catch (e) {
				console.log(`  WARNING: cleanup failed: ${(e as Error).message}`);
			}
		} else {
			kv("Cleanup", `session ${session.id} kept for inspection (failed)`);
		}
	} else {
		kv("Cleanup", `session ${session.id} kept (--keep)`);
	}

	console.log("");
	console.log(HR);
}

function formatTrigger(t: PluginFlowTrigger): string {
	const parts: string[] = [t.type];
	if (t.interval !== undefined) parts.push(`interval=${t.interval}`);
	if (t.cooldownTurns !== undefined) parts.push(`cd=${t.cooldownTurns}`);
	if (t.maxTriggerCount !== undefined) parts.push(`max=${t.maxTriggerCount}`);
	if (t.startTurn !== undefined && t.startTurn > 1)
		parts.push(`start=${t.startTurn}`);
	return parts.join(" ");
}

main().catch((e: Error) => {
	console.error("");
	console.error(`FATAL: ${e.message}`);
	if (e.stack) console.error(e.stack);
	process.exit(2);
});
