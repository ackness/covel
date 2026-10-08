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
 *   2. Real config by default. Every runtime uses the model the server's
 *      configuration routes it to, exactly as in play; Phase 6 prints the
 *      slot / provider / model each runtime called. `--slot <name>` or
 *      `E2E_MODEL_SLOT=<name>` overrides the story runtime through the
 *      `model` field on /api/actions. Slot names are the bare part of
 *      `[covel.xxx]` in llm.toml (e.g. `story`, `e2e_local`).
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
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/e2e-plugin-verify.ts [options]
 *
 * Options:
 *   --server <url>         API base (default: http://localhost:3001/api)
 *   --slot <name>          Override the story runtimes' model slot (default: configured routing)
 *   --world <id>           World to use (default: first world returned by /api/worlds)
 *   --locale <tag>         Session content locale (default: zh-CN)
 *   --session-id <id>      Create the session under this ID (default: the world ID plus a
 *                          random suffix). A fixed ID is one of the conditions for two runs
 *                          to send the same model requests.
 *   --turns <n>            Number of playing-phase turns to run after char-creation (default: 3)
 *   --runtime <id>         Filter output + assertions to this runtime only
 *   --plugin <id>          Filter output + assertions to this plugin only
 *   --enable-plugins <ids> Enable comma-separated plugins before the first turn
 *   --core-only            Create the session with core plugins only instead of
 *                          the world's preset pack
 *   --player-message <str> Player text for each playing turn (default: cycles through built-ins)
 *   --form-values <json>   Default form field values (default: auto from field types)
 *   --timeout <seconds>    Per-turn SSE timeout (default: 300)
 *   --log-dir <path>       Directory for log artefacts (default: debugs/e2e-logs)
 *   --no-log               Disable log persistence
 *   --verbose              Print verbose SSE event log
 *   --keep                 Keep session after test (default: delete if passed)
 *   --require-compaction   Fail unless context.compacted is observed
 *   --require-summary-use  Fail unless a later LLM prompt contains <compacted_history>
 *   --require-tools <ids>  Require comma-separated tool.completed names
 *   --strict-traces        Fail on any *.failed/error LLM trace
 *   --no-language-check    Do not check that model output is in the session's language
 *   --max-input-tokens <n> Fail when provider-reported input usage exceeds n
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
import {
  languageVerdict,
  outputLanguageReport,
  promptLanguageReport,
  rejectedToolCalls,
} from "./lib/e2e-output-checks.mjs";

// ──────────────────────────────────────────────────────────────────
// CLI argument parsing
// ──────────────────────────────────────────────────────────────────

interface CliArgs {
  server: string;
  /** Story-runtime slot override; absent means the configured routing. */
  slot?: string;
  world?: string;
  /** Content locale of the session; also selects the prompt language. */
  locale: string;
  /** The session's ID; absent means the server allocates one. */
  sessionId?: string;
  turns: number;
  runtimeFilter?: string;
  pluginFilter?: string;
  enablePlugins: string[];
  coreOnly: boolean;
  playerMessage?: string;
  formValues: Record<string, string>;
  timeoutSec: number;
  verbose: boolean;
  keep: boolean;
  logDir: string;
  logEnabled: boolean;
  requireCompaction: boolean;
  requireSummaryUse: boolean;
  requireTools: string[];
  strictTraces: boolean;
  languageCheck: boolean;
  maxInputTokens?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    server: "http://localhost:3001/api",
    slot: process.env.E2E_MODEL_SLOT?.trim() || undefined,
    locale: "zh-CN",
    turns: 3,
    enablePlugins: [],
    coreOnly: false,
    formValues: {},
    timeoutSec: 300,
    verbose: false,
    keep: false,
    logDir: "debugs/e2e-logs",
    logEnabled: true,
    requireCompaction: false,
    requireSummaryUse: false,
    requireTools: [],
    strictTraces: false,
    languageCheck: true,
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
      case "--locale":
        args.locale = next();
        break;
      case "--session-id":
        args.sessionId = next();
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
      case "--enable-plugins":
        args.enablePlugins = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--core-only":
        args.coreOnly = true;
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
      case "--require-compaction":
        args.requireCompaction = true;
        break;
      case "--require-summary-use":
        args.requireSummaryUse = true;
        break;
      case "--require-tools":
        args.requireTools = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case "--strict-traces":
        args.strictTraces = true;
        break;
      case "--no-language-check":
        args.languageCheck = false;
        break;
      case "--max-input-tokens":
        args.maxInputTokens = Number.parseInt(next(), 10);
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
  if (
    args.maxInputTokens !== undefined &&
    (!Number.isInteger(args.maxInputTokens) || args.maxInputTokens <= 0)
  ) {
    throw new Error("--max-input-tokens must be > 0");
  }

  return args;
}

function printHelp(): void {
  const help = `
Covel E2E Plugin Verification

Usage:
  npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/e2e-plugin-verify.ts [options]

Options:
  --server <url>          API base (default: http://localhost:3001/api)
  --slot <name>           Override the story runtimes' model slot (default: configured routing)
                          Slot names come from [covel.xxx] in llm.toml,
                          pass only the xxx part (e.g. e2e, e2e_local)
  --world <id>            World to use (default: first available)
  --locale <tag>          Session content locale (default: zh-CN)
  --session-id <id>       Create the session under this ID (default: allocated by the server)
  --turns <n>             Playing-phase turns after char creation (default: 3)
  --runtime <id>          Filter output + assertions to this runtime only
  --plugin <id>           Filter output + assertions to this plugin only
  --enable-plugins <ids>  Enable comma-separated plugins before the first turn
  --core-only             Core plugins only, not the world's preset pack
  --player-message <str>  Player text for each playing turn
  --form-values <json>    Default form field values
  --timeout <seconds>     Per-turn SSE timeout (default: 300)
  --log-dir <path>        Directory for log artefacts (default: debugs/e2e-logs)
  --no-log                Disable log persistence
  --verbose               Print verbose SSE event log
  --keep                  Keep session after test
  --require-compaction    Require a context.compacted trace
  --require-summary-use   Require <compacted_history> in a later LLM prompt
  --require-tools <ids>   Require comma-separated tool.completed names
  --strict-traces         Fail on any *.failed trace or error LLM response
  --no-language-check     Skip the check that model output is in the session's language
  --max-input-tokens <n>  Enforce provider-reported input usage ceiling
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

// Named scheduling stages replaced the old numeric priority bands. A staged
// runtime maps 1:1 to its stage segment; stage-less runtimes (event / manual /
// contribution-only) carry no `stage` and group under "event-manual" — they
// are NOT scheduled into a turn regardless of their trigger.type.
type FlowStage = "setup" | "pre-turn" | "narrative" | "post-turn" | "audit";
type FlowSegmentId = FlowStage | "event-manual";

interface PluginFlowStep {
  id: string;
  pluginId: string;
  pluginName: string;
  runtimeId: string;
  runtimeName: string;
  stage?: FlowStage;
  segmentId: FlowSegmentId;
  runtimeType: string;
  outputKind: string;
  trigger: PluginFlowTrigger;
  /** `detached` runtimes commit with the turn and run as background jobs. */
  turnCompletion?: { mode: string };
  tools: { builtin: string[]; local: string[] };
  isStoryRuntime: boolean;
}

interface PluginFlowResponse {
  segments: Array<{
    id: FlowSegmentId;
    label: string;
  }>;
  plugins: Array<{
    id: string;
    pluginType: string;
    runtimeIds: string[];
  }>;
  steps: PluginFlowStep[];
}

interface SessionRecord {
  id: string;
  worldId?: string;
  status: string;
  phase: "setup" | "playing";
  completedPlayerTurns: number;
  setupRuntimes: Readonly<
    Record<string, { state: string; attempts?: number; reason?: string }>
  >;
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
  effects?: { interactions?: unknown[] };
  toolCalls?: ToolCallRecord[];
  durationMs: number;
}

interface TurnRecord {
  turnId: string;
  sessionId: string;
  origin?: string;
  runtimeResults: RuntimeResultRecord[];
  durationMs: number;
  timestamp: string;
}

interface SseEvent {
  type: string;
  /** Envelope turnId: one per execution on the stream. */
  turnId?: string;
  payload: Record<string, unknown>;
}

interface RuntimeJobRecord {
  jobId: string;
  runtimeId: string;
  status: string;
  reason?: string;
  error?: string;
  origin: { activation: string; sourceTurnId?: string };
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

async function httpJson<T>(
  server: string,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<T> {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(payload)}`,
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
              turnId?: string;
              payload?: Record<string, unknown>;
            };
            const type = parsed.type ?? "unknown";
            const payload = parsed.payload ?? {};
            onEvent({
              type,
              ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
              payload,
            });
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

function summariseOutput(rt: RuntimeResultRecord): string {
  const output = rt.output;
  const effectInteractions = rt.effects?.interactions?.length ?? 0;
  if (!output)
    return effectInteractions > 0 ? `interactions=${effectInteractions}` : "-";
  const parts: string[] = [];
  if (
    typeof output.narrativeOutput === "string" &&
    output.narrativeOutput.length > 0
  ) {
    parts.push(`narrative(${output.narrativeOutput.length}c)`);
  }
  const interactions =
    effectInteractions +
    (Array.isArray(output.interactions) ? output.interactions.length : 0);
  if (interactions > 0) parts.push(`interactions=${interactions}`);
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
// Trigger expectation — derived from the stage scheduler, not priority bands
// ──────────────────────────────────────────────────────────────────

// Segment display / sort order. Stage-less runtimes ("event-manual") rank
// last, mirroring server-side stageRank (packages/shared scheduling).
const SEGMENT_ORDER: readonly FlowSegmentId[] = [
  "setup",
  "pre-turn",
  "narrative",
  "post-turn",
  "audit",
  "event-manual",
];

function segmentRank(id: string): number {
  const i = SEGMENT_ORDER.indexOf(id as FlowSegmentId);
  return i === -1 ? SEGMENT_ORDER.length : i;
}

/** Which lifecycle band a turn runs in, mirroring `session.phase`. */
type TurnBand = "setup" | "playing";

/**
 * How a runtime relates to the current turn under the stage scheduler.
 *   inactive  — plugin not in the session's activePlugins (never scheduled).
 *   unstaged  — no stage: event / manual / contribution-only. Fires only on
 *               its own event/manual trigger, never as part of a staged turn.
 *   off-band  — staged, active, but its stage does not run in this band.
 *   setup     — a setup-stage runtime in the setup band. Completion is judged
 *               authoritatively from `session.setupRuntimes`, not per turn
 *               (setup work can settle inside the form-submit sub-execution
 *               the turn loop does not read back).
 *   gated     — staged, active, in-band, but `startTurn` or the `scheduled`
 *               interval excludes this logical turn.
 *   auto      — staged, active, in-band, plain trigger auto → expected every
 *               turn.
 *   scheduled — staged, active, in-band, trigger scheduled (or auto bounded by
 *               cooldownTurns / maxTriggerCount) → asserted to fire ≥1 time
 *               across the turns that allow it (cooldown and trigger counts
 *               are not re-simulated; the run-level check lives in Phase 7).
 *
 * Detached runtimes (`turnCompletion.mode: detached`) count as run when the
 * turn's stream announces them with `runtime.deferred`; their background
 * outcome is checked in Phase 6.
 */
type ExpectClass =
  | "inactive"
  | "unstaged"
  | "off-band"
  | "setup"
  | "gated"
  | "auto"
  | "scheduled";

interface StepExpectation {
  cls: ExpectClass;
  reason: string;
}

/**
 * Derive a runtime's turn expectation from the modern stage scheduler.
 *
 * The single source of truth is the session's active-plugin set intersected
 * with each runtime's `stage`/`trigger` — NOT the retired numeric priority
 * bands and NOT a re-simulation of interval/cooldown. Three gates in order:
 *   1. active set — mutually-exclusive providers (narrator vs
 *      chat-mode-narrator) resolve here: only the active one is expected.
 *   2. stage — a stage-less runtime (memory / history-compaction: `auto`
 *      but no stage) is never stage-scheduled.
 *   3. band — setup-stage runs only in the setup phase; all other stages run
 *      only in playing turns.
 */
function classifyStep(
  step: PluginFlowStep,
  band: TurnBand,
  active: ReadonlySet<string>,
  /** `completedPlayerTurns + 1` as the execution saw it. */
  logicalTurn: number,
): StepExpectation {
  if (!active.has(step.pluginId)) {
    return { cls: "inactive", reason: "plugin not in session active set" };
  }
  if (step.stage === undefined) {
    return {
      cls: "unstaged",
      reason: `${step.trigger.type}/no-stage (event·manual·contribution)`,
    };
  }
  if (step.stage === "setup") {
    return band === "setup"
      ? { cls: "setup", reason: "setup stage — via setupRuntimes" }
      : { cls: "off-band", reason: "setup stage — idle in playing band" };
  }
  // Non-setup stages (pre-turn / narrative / post-turn / audit) run in playing
  // turns only.
  if (band !== "playing") {
    return {
      cls: "off-band",
      reason: `${step.stage} stage — idle in setup band`,
    };
  }
  const { type, startTurn, interval, cooldownTurns, maxTriggerCount } =
    step.trigger;
  if (type !== "auto" && type !== "scheduled") {
    // Defensive: a staged runtime with an event/manual trigger is not
    // expected by the stage scheduler.
    return { cls: "unstaged", reason: `trigger ${type}` };
  }
  if (startTurn !== undefined && logicalTurn < startTurn) {
    return {
      cls: "gated",
      reason: `startTurn ${startTurn} > logical turn ${logicalTurn}`,
    };
  }
  if (type === "scheduled" && logicalTurn % (interval ?? 1) !== 0) {
    return {
      cls: "gated",
      reason: `interval ${interval} skips logical turn ${logicalTurn}`,
    };
  }
  if (
    type === "auto" &&
    cooldownTurns === undefined &&
    maxTriggerCount === undefined
  ) {
    return { cls: "auto", reason: "auto — every in-band turn" };
  }
  return {
    cls: "scheduled",
    reason: `${type} — ≥1 across allowed turns`,
  };
}

// ──────────────────────────────────────────────────────────────────
// Form auto-fill from runtime result
// ──────────────────────────────────────────────────────────────────

/** Forms the harness submits during setup before it stops auto-filling. */
const MAX_SETUP_FORMS = 3;

interface DetectedForm {
  turnId: string;
  runtimeId: string;
  interactionId: string;
  fields: Array<{
    name: string;
    type: string;
    required?: boolean;
    options?: Array<string | { value?: string; label?: string }>;
    min?: number;
    max?: number;
    defaultValue?: unknown;
  }>;
  /** The form's declared validator, e.g. `{ name: "point-buy", data }`. */
  validation?: { name?: unknown; data?: unknown };
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
    // Path 1: interactions[] with type='form' — runtimes return them as
    // effects; older outputs carried them on `output`.
    const interactions = [
      ...(rt.effects?.interactions ?? []),
      ...(Array.isArray(rt.output?.interactions) ? rt.output.interactions : []),
    ];
    for (const interaction of interactions) {
      if (!interaction || typeof interaction !== "object") continue;
      const obj = interaction as Record<string, unknown>;
      if (obj.type === "form") {
        return toDetectedForm(turnId, rt.runtimeId, obj);
      }
    }

    // Path 2: create-form tool call input (fallback if output doesn't carry
    // the form but the tool call does)
    for (const tc of rt.toolCalls ?? []) {
      if (
        tc.toolName !== "create-form" &&
        tc.toolName !== "create-character-form"
      )
        continue;
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
      min: typeof f.min === "number" ? f.min : undefined,
      max: typeof f.max === "number" ? f.max : undefined,
      defaultValue: f.defaultValue,
    }))
    .filter((f) => f.name.length > 0);
  const validation =
    source.validation && typeof source.validation === "object"
      ? (source.validation as { name?: unknown; data?: unknown })
      : undefined;

  return {
    turnId,
    runtimeId,
    interactionId: String(
      source.interactionId ?? source.formId ?? source.id ?? "form",
    ),
    fields,
    validation,
  };
}

/**
 * Materialise form values from user overrides + heuristic defaults.
 * Missing required fields are filled with placeholder data derived from
 * the field type so the submission always satisfies the schema.
 */
/**
 * Test input is written in the session's language. A Chinese name or message
 * in a session of another locale is itself Chinese context for the model and
 * hides what the pipeline does on its own.
 */
function isChineseLocale(locale: string): boolean {
  return /^zh(-|$)/i.test(locale);
}

function buildFormValues(
  form: DetectedForm,
  overrides: Record<string, string>,
  locale: string,
): Record<string, string | number> {
  const chinese = isChineseLocale(locale);
  const testName = chinese ? "E2E测试角色" : "E2E Tester";
  const values: Record<string, string | number> = {};

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
        field.name === "characterName"
          ? testName
          : chinese
            ? `测试${field.name}`
            : `test ${field.name}`;
      continue;
    }
    if (field.type === "number") {
      values[field.name] =
        typeof field.defaultValue === "number"
          ? field.defaultValue
          : (field.min ?? 0);
      continue;
    }
    values[field.name] = "";
  }
  spendPointBuyBudget(form, overrides, values);

  // Safety net: at least characterName for auto-advanced flows that
  // skipped fields we didn't understand.
  if (Object.keys(values).length === 0) {
    values.characterName = overrides.characterName ?? testName;
  }

  return values;
}

/**
 * A `point-buy` form accepts only an allocation that spends its whole budget
 * (`validation.data.budget`) above each field's minimum. Spread the budget
 * one point at a time over the number fields the caller did not override.
 */
function spendPointBuyBudget(
  form: DetectedForm,
  overrides: Record<string, string>,
  values: Record<string, string | number>,
): void {
  if (form.validation?.name !== "point-buy") return;
  const data = form.validation.data as { budget?: unknown } | undefined;
  const budget = typeof data?.budget === "number" ? data.budget : 0;
  const open = form.fields.filter(
    (field) => field.type === "number" && overrides[field.name] === undefined,
  );
  let left =
    budget -
    form.fields.reduce(
      (spent, field) =>
        field.type === "number"
          ? spent + (Number(values[field.name]) - (field.min ?? 0))
          : spent,
      0,
    );
  while (left > 0) {
    const field = open.find(
      (candidate) =>
        candidate.max === undefined ||
        Number(values[candidate.name]) < candidate.max,
    );
    if (!field) break;
    values[field.name] = Number(values[field.name]) + 1;
    open.push(open.splice(open.indexOf(field), 1)[0]!);
    left -= 1;
  }
}

// ──────────────────────────────────────────────────────────────────
// Turn execution
// ──────────────────────────────────────────────────────────────────

interface TurnExecution {
  /**
   * Executions this request ran, in stream order: one, or two when the
   * request completed setup and chained the opening continuation.
   */
  turnRecords: TurnRecord[];
  /** The last execution — the one the session's current band belongs to. */
  turnRecord: TurnRecord;
  /** Detached runtimes the stream announced with `runtime.deferred`. */
  deferred: ReadonlySet<string>;
  /** `execution.completed.committed`; undefined when the event never came. */
  committed?: boolean;
  completionError?: string;
  sseEvents: SseEvent[];
  elapsedMs: number;
  terminated: boolean;
  terminatedReason?: string;
}

/**
 * Post an action, consume the SSE stream, and return the executions it ran,
 * read back from /sessions/:id/turns by the envelope turnIds. That listing
 * also holds background and detached executions, so "the newest row" is not
 * necessarily this request's. Soft stream terminations (upstream LLM
 * disconnects) are surfaced in the returned record so the test can continue;
 * the backend may still have committed a partial turn that's worth
 * inspecting.
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

  const turnsResp = await httpGet<{ items: TurnRecord[] }>(
    args.server,
    `/sessions/${sessionId}/turns`,
  );
  const turns = turnsResp.items ?? [];
  if (turns.length === 0) {
    throw new Error("No turns returned from /turns after action");
  }
  const streamTurnIds = [
    ...new Set(sseEvents.flatMap((evt) => (evt.turnId ? [evt.turnId] : []))),
  ];
  const matched = streamTurnIds.flatMap((turnId) =>
    turns.filter((turn) => turn.turnId === turnId),
  );
  // A stream cut before its first envelope leaves only the newest row.
  const turnRecords = matched.length > 0 ? matched : [turns[turns.length - 1]];
  const completed = sseEvents.find((evt) => evt.type === "execution.completed");
  const deferred = new Set(
    sseEvents
      .filter((evt) => evt.type === "runtime.deferred")
      .map((evt) => String(evt.payload.runtimeId ?? "")),
  );

  return {
    turnRecords,
    turnRecord: turnRecords[turnRecords.length - 1],
    deferred,
    ...(completed
      ? {
          committed: completed.payload.committed === true,
          ...(typeof completed.payload.error === "string"
            ? { completionError: completed.payload.error }
            : {}),
        }
      : {}),
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
  /** Mirrors the session lifecycle clock used for band selection. */
  phase: TurnBand;
  /** Mirrors the count of completed player turns in the main loop. */
  completedPlayerTurns: number;
  /** Mirrors `session.status` — 'active' | 'paused' | 'ended'. */
  status: string;
  flow: PluginFlowResponse;
  /** Session's live active-plugin set (pluginIds); refreshed each turn. */
  active: Set<string>;
  /** Runtimes classified `scheduled` (in-band) in ≥1 turn — the opportunity set. */
  scheduledOpportunity: Set<string>;
  /** Runtimes that fired OK while classified `scheduled`. */
  scheduledFired: Set<string>;
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
  console.log("");
  console.log(`  Elapsed: ${(exec.elapsedMs / 1000).toFixed(1)}s`);
  if (exec.committed === false) {
    console.log(`  NOT COMMITTED: ${exec.completionError ?? "unknown error"}`);
    ctx.assertions.fail(
      `turn ${ctx.turnNumber + 1} did not commit: ${exec.completionError ?? "unknown error"}`,
    );
  } else if (exec.committed === undefined && !exec.terminated) {
    ctx.assertions.warn(
      `turn ${ctx.turnNumber + 1} ended without execution.completed`,
    );
  }
  exec.turnRecords.forEach((turnRecord, index) => {
    // A chained request first ran the execution that finished setup; only
    // its last execution runs in the session's current band.
    const last = index === exec.turnRecords.length - 1;
    if (!last) console.log("  (setup execution)");
    else if (exec.turnRecords.length > 1)
      console.log("  (opening continuation)");
    reportExecution(ctx, exec, turnRecord, last ? ctx.phase : "setup");
  });
}

function reportExecution(
  ctx: PerTurnContext,
  exec: TurnExecution,
  turnRecord: TurnRecord,
  band: TurnBand,
): void {
  const ran = new Map(
    turnRecord.runtimeResults.map((r) => [r.runtimeId, r] as const),
  );
  // Only the last execution of a request carries this turn's deferrals.
  const deferred: ReadonlySet<string> =
    turnRecord === exec.turnRecord ? exec.deferred : new Set();

  // ── Runtime timeline ──────────────────────────────────────────
  console.log("");
  console.log(`  TurnId: ${turnRecord.turnId}`);

  const timelineRows: string[][] = [];
  // Order by (stage, name) — the priority-band ordinal is gone; the stage
  // scheduler orders within a stage by dependencies only.
  const orderedSteps = [...ctx.flow.steps].sort(
    (a, b) =>
      segmentRank(a.segmentId) - segmentRank(b.segmentId) ||
      a.runtimeId.localeCompare(b.runtimeId),
  );

  for (const step of orderedSteps) {
    if (!runtimePasses(step, ctx.runtimeFilter, ctx.pluginFilter)) continue;
    const rt = ran.get(step.runtimeId);
    if (!rt) continue;
    timelineRows.push([
      step.stage ?? "-",
      step.runtimeId,
      rt.status,
      `${(rt.durationMs / 1000).toFixed(1)}s`,
      summariseOutput(rt),
    ]);
  }
  for (const runtimeId of deferred) {
    if (ran.has(runtimeId)) continue;
    const step = ctx.flow.steps.find((s) => s.runtimeId === runtimeId);
    if (step && !runtimePasses(step, ctx.runtimeFilter, ctx.pluginFilter))
      continue;
    timelineRows.push([step?.stage ?? "-", runtimeId, "deferred", "-", "-"]);
  }

  // Include ran-but-not-in-flow runtimes (sub-runtimes discovered after flow fetch)
  for (const rt of turnRecord.runtimeResults) {
    const inFlow = ctx.flow.steps.some((s) => s.runtimeId === rt.runtimeId);
    if (inFlow) continue;
    if (ctx.runtimeFilter && rt.runtimeId !== ctx.runtimeFilter) continue;
    if (ctx.pluginFilter && rt.pluginId !== ctx.pluginFilter) continue;
    timelineRows.push([
      "-",
      rt.runtimeId,
      rt.status,
      `${(rt.durationMs / 1000).toFixed(1)}s`,
      summariseOutput(rt),
    ]);
  }

  console.log("");
  console.log("  Runtime Timeline:");
  printTable(["stage", "runtime", "status", "dur", "output"], timelineRows);

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
  // Verdicts derive from `classifyStep` (stage scheduler), not priority bands:
  //   PASS  — expected (auto/setup) and ran OK.
  //   FAIL  — an in-band `auto` runtime did not run, or any expected runtime
  //           ran with a non-success status. Scheduled misses are NOT failed
  //           here; the run-level ≥1 check in Phase 7 owns them.
  //   DEFER — a detached runtime committed with the turn and moved to a
  //           background job (`runtime.deferred`); Phase 6 checks the job.
  //   WAIT  — scheduled runtime idle this turn (cooldown / trigger count may
  //           gate), or a setup runtime not yet resolved (Phase 6 owns it).
  //   FIRE  — a stage-less event/manual runtime fired (informational).
  //   WARN  — an inactive / off-band runtime ran unexpectedly (soft anomaly).
  //   SKIP  — not expected this turn (inactive / unstaged / off-band / gated).
  console.log("");
  console.log("  Trigger Verification:");
  const triggerRows: string[][] = [];
  for (const step of orderedSteps) {
    if (!runtimePasses(step, ctx.runtimeFilter, ctx.pluginFilter)) continue;
    const { cls, reason } = classifyStep(
      step,
      band,
      ctx.active,
      ctx.completedPlayerTurns + 1,
    );
    const rt = ran.get(step.runtimeId);
    const wasDeferred = rt === undefined && deferred.has(step.runtimeId);
    const ranIt = rt !== undefined || wasDeferred;
    // A runtime that appears in the results was reached by the scheduler.
    // `skipped` means reached-but-declined (guard/no-op / already done) — it is
    // NOT a failure and counts as "triggered". Only `failed` is an error.
    const ranActed =
      wasDeferred || rt?.status === "success" || rt?.status === "completed";
    const ranFailed = rt?.status === "failed";
    const ranSkipped = ranIt && !ranActed && !ranFailed;
    const acted = wasDeferred ? "DEFER" : "PASS";

    let verdict: string;
    let expectedCol: string;
    switch (cls) {
      case "inactive":
      case "off-band":
      case "gated":
        expectedCol = "no";
        if (ranIt) {
          verdict = "WARN";
          ctx.assertions.warn(`${step.runtimeId} ran but ${reason}`);
        } else {
          verdict = "SKIP";
        }
        break;
      case "unstaged":
        expectedCol = "-";
        verdict = ranIt ? "FIRE" : "SKIP";
        break;
      case "setup":
        // Completion is asserted in Phase 6 from setupRuntimes; per turn we
        // only surface progress (and flag a hard failure). No per-turn pass
        // assertion — that would double-count Phase 6.
        expectedCol = "setup";
        if (ranFailed) {
          verdict = "FAIL";
          ctx.assertions.fail(
            `${step.runtimeId} ran with status=${rt!.status}`,
          );
        } else {
          verdict = ranActed ? "PASS" : ranSkipped ? "SKIP" : "WAIT";
        }
        break;
      case "auto":
        expectedCol = "yes";
        if (ranActed) {
          verdict = acted;
          ctx.assertions.pass(`${step.runtimeId} triggered`);
        } else if (ranFailed) {
          verdict = "FAIL";
          ctx.assertions.fail(
            `${step.runtimeId} ran with status=${rt!.status}`,
          );
        } else if (ranSkipped) {
          // Reached but no-op'd this turn — not a failure.
          verdict = "SKIP";
        } else if (exec.committed === false) {
          // A rolled-back turn never defers its detached runtimes; the
          // commit failure is already asserted.
          verdict = "SKIP";
        } else {
          verdict = "FAIL";
          ctx.assertions.fail(`${step.runtimeId} (auto) did not trigger`);
        }
        break;
      case "scheduled":
        expectedCol = "≥1";
        ctx.scheduledOpportunity.add(step.runtimeId);
        if (ranActed) {
          verdict = acted;
          ctx.scheduledFired.add(step.runtimeId);
          ctx.assertions.pass(`${step.runtimeId} triggered`);
        } else if (ranFailed) {
          verdict = "FAIL";
          ctx.assertions.fail(
            `${step.runtimeId} ran with status=${rt!.status}`,
          );
        } else if (ranSkipped) {
          // Reached (scheduler selected it) but declined — satisfies ≥1.
          verdict = "SKIP";
          ctx.scheduledFired.add(step.runtimeId);
        } else {
          verdict = "WAIT";
        }
        break;
    }

    triggerRows.push([
      verdict,
      step.runtimeId,
      expectedCol,
      ranIt ? "yes" : "no",
      reason,
    ]);
  }
  printTable(
    ["result", "runtime", "expected", "actual", "reason"],
    triggerRows,
  );
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
  traces: unknown;
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
    traces: null,
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
          const resp = await httpGet<{ items: TurnRecord[] }>(
            args.server,
            `/sessions/${state.sessionId}/turns`,
          );
          state.finalTurns = resp.items ?? [];
        } catch {
          /* backend unreachable — artefact will be empty */
        }
      }
      saveArtefact(sink, `${state.sessionId}-turns`, state.finalTurns);
      if (state.snapshot) {
        saveArtefact(sink, `${state.sessionId}-snapshot`, state.snapshot);
      }
      if (state.traces) {
        saveArtefact(sink, `${state.sessionId}-traces`, state.traces);
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
        `    (turns / snapshot / traces / failures / fatal written next to the log)`,
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
  kv("Slot", args.slot ?? "(configured routing)");
  kv("Turns", args.turns);
  kv("Runtime filter", args.runtimeFilter ?? "(none)");
  kv("Plugin filter", args.pluginFilter ?? "(none)");
  kv("Enable plugins", args.enablePlugins.join(", ") || "(none)");
  kv("Require tools", args.requireTools.join(", ") || "(none)");
  kv("Timeout", `${args.timeoutSec}s`);
  kv("Timestamp", new Date().toISOString());
  if (sink) kv("Log file", sink.logPath);

  const assertions = new Assertions();

  // ── Phase 1: Health ────────────────────────────────────────────
  section("Phase 1: Health Check");
  try {
    const health = await httpGet<{
      status: string;
      storage?: { data?: { backend?: string } };
      bootId: string;
    }>(args.server, "/health");
    kv("Status", health.status);
    kv("Store backend", health.storage?.data?.backend ?? "(unknown)");
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
    const segSteps = flow.steps.filter((s) => s.segmentId === seg.id);
    if (segSteps.length === 0) continue;
    console.log("");
    console.log(`  ${seg.label} [${seg.id}]`);
    const rows = segSteps
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId))
      .map((s) => [
        s.stage ?? "-",
        s.runtimeId,
        s.runtimeType,
        s.outputKind,
        formatTrigger(s.trigger),
      ]);
    printTable(["stage", "runtime", "type", "output", "trigger"], rows);
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
  kv("Locale", args.locale);

  // ── Phase 4: Session creation ──────────────────────────────────
  // Start the way the prep screen does: the world's preset pack plus the
  // plugins the world requires. A session created from worldId alone holds
  // only the core plugins and would not exercise what players play.
  section("Phase 4: Session Creation");
  let plugins: string[] | undefined;
  if (!args.coreOnly) {
    const plan = await httpGet<{
      selectedPackId?: string;
      defaultPluginIds?: string[];
      policy?: { requested?: string[] };
    }>(args.server, `/worlds/${encodeURIComponent(chosen.id)}/plugin-plan`);
    plugins = [
      ...new Set([
        ...(plan.defaultPluginIds ?? []),
        ...(plan.policy?.requested ?? []),
      ]),
    ];
    kv("Preset pack", plan.selectedPackId ?? "(none)");
  }
  const session = await httpJson<SessionRecord>(args.server, "/sessions", {
    worldId: chosen.id,
    locale: args.locale,
    ...(args.sessionId ? { id: args.sessionId } : {}),
    ...(plugins ? { plugins } : {}),
  });
  state.sessionId = session.id;
  kv("Session ID", session.id);
  kv("Status", session.status);
  kv("Phase", session.phase);
  kv("Completed player turns", session.completedPlayerTurns);

  let preparedSession = session;
  for (const pluginId of args.enablePlugins) {
    const enabled = await httpJson<{ ok: true; activePluginIds: string[] }>(
      args.server,
      `/sessions/${encodeURIComponent(session.id)}/plugins/${encodeURIComponent(pluginId)}`,
      undefined,
      "PUT",
    );
    if (!enabled.ok) {
      throw new Error(`failed to enable plugin ${pluginId}`);
    }
    kv(`Enabled plugin`, pluginId);
  }
  if (args.enablePlugins.length > 0) {
    preparedSession = await httpGet<SessionRecord>(
      args.server,
      `/sessions/${session.id}`,
    );
  }

  // ── Phase 5: Turn execution ────────────────────────────────────
  section("Phase 5: Turn Execution");

  const ctx: PerTurnContext = {
    turnNumber: 0,
    phase: preparedSession.phase,
    completedPlayerTurns: preparedSession.completedPlayerTurns,
    status: preparedSession.status,
    flow,
    // Expectations are derived against the session's REAL active set (seeded
    // by the world manifest at create), not the global plugin pool. Read it
    // back from the create response, then refresh from each session re-fetch.
    active: new Set(preparedSession.activePlugins ?? []),
    scheduledOpportunity: new Set(),
    scheduledFired: new Set(),
    assertions,
    runtimeFilter: args.runtimeFilter,
    pluginFilter: args.pluginFilter,
  };
  kv("Active plugins", [...ctx.active].join(", ") || "(none)");

  // Fold a fresh SessionRecord into the context: lifecycle band + live active
  // set (enable/disable mid-session applies next turn, so re-read every turn).
  function refreshSession(rec: SessionRecord): void {
    ctx.phase = rec.phase;
    ctx.completedPlayerTurns = rec.completedPlayerTurns;
    ctx.status = rec.status;
    if (rec.activePlugins) ctx.active = new Set(rec.activePlugins);
  }

  function bandLabel(): string {
    return ctx.phase;
  }

  // Turn 1: start_session
  console.log("");
  console.log(
    `  Turn ${ctx.turnNumber + 1}: start_session (phase=${bandLabel()}, completedPlayerTurns=${ctx.completedPlayerTurns})`,
  );
  console.log(DIV);
  let exec = await runTurn(args, session.id, {
    type: "start_session",
    payload: {},
  });
  reportTurn(ctx, exec);

  // Advance report sequence.
  ctx.turnNumber += 1;

  // Auto form handling: setup can chain forms (character creation, then a
  // rules plugin's point allocation). Submit each form the last request
  // surfaced and post send_message to advance, until setup asks for no more.
  const submittedForms = new Set<string>();
  const nextSetupForm = (): DetectedForm | null => {
    for (const record of exec.turnRecords) {
      const form = detectFormInTurn(record.turnId, record.runtimeResults);
      if (form && !submittedForms.has(form.interactionId)) return form;
    }
    return null;
  };
  let detectedForm = nextSetupForm();
  while (detectedForm && submittedForms.size < MAX_SETUP_FORMS) {
    submittedForms.add(detectedForm.interactionId);
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

    const values = buildFormValues(detectedForm, args.formValues, args.locale);
    kv("Values", previewJson(values, 120));

    const submitResp = await httpJson<{
      status: string;
      result?: {
        results?: Array<{ filledNarrative?: string }>;
      };
    }>(args.server, `/sessions/${session.id}/plugin-rpc`, {
      kind: "action",
      pluginId: "framework",
      action: "submit-form",
      payload: {
        turnId: detectedForm.turnId,
        submissions: [
          {
            interactionId: detectedForm.interactionId,
            type: "form",
            values,
          },
        ],
      },
    });
    const filled = submitResp.result?.results?.[0]?.filledNarrative ?? "";
    if (filled) kv("Filled narrative", truncate(filled, 80));

    // Refresh phase from server — the submit-form + turn commit chain may
    // have advanced the lifecycle into playing already.
    const sessAfterSubmit = await httpGet<SessionRecord>(
      args.server,
      `/sessions/${session.id}`,
    );
    refreshSession(sessAfterSubmit);

    console.log("");
    console.log(
      `  Turn ${ctx.turnNumber + 1}: send_message (after form submit, phase=${bandLabel()}, completedPlayerTurns=${ctx.completedPlayerTurns})`,
    );
    console.log(DIV);
    exec = await runTurn(args, session.id, {
      type: "send_message",
      payload: { content: filled || "继续" },
    });
    // The request that completes the LAST setup runtime chains one main-loop
    // turn onto the same SSE stream ("opening continuation", see api.md) under
    // a new turnId; `runTurn` returns both executions. Re-read the session
    // before classifying so the continuation is judged in the band it ran in.
    // When setup did NOT finish, phase stays setup and a genuine off-band run
    // is still flagged.
    refreshSession(
      await httpGet<SessionRecord>(args.server, `/sessions/${session.id}`),
    );
    reportTurn(ctx, exec);
    ctx.turnNumber += 1;
    detectedForm = ctx.phase === "setup" ? nextSetupForm() : null;
  }

  // Remaining playing-band turns
  const sess = await httpGet<SessionRecord>(
    args.server,
    `/sessions/${session.id}`,
  );
  refreshSession(sess);

  const defaultPlayerMessages = isChineseLocale(args.locale)
    ? [
        "探索周围环境，寻找任何可以利用的线索。",
        "与同伴交流，分享彼此的判断和下一步的打算。",
        "小心靠近目标区域，保持警觉地观察环境。",
        "尝试回忆此前发生过的事件，看看是否能关联起来。",
        "根据掌握的信息做出谨慎的决定，然后继续前进。",
      ]
    : [
        "Explore the surroundings and look for any clue that can be used.",
        "Talk with your companions; share what each of you thinks and plans to do next.",
        "Approach the target area carefully and watch the surroundings.",
        "Try to recall what happened earlier and see whether the events connect.",
        "Make a careful decision from what you know, then move on.",
      ];

  for (let i = 0; i < args.turns; i++) {
    const content =
      args.playerMessage ??
      defaultPlayerMessages[i % defaultPlayerMessages.length];
    console.log("");
    console.log(
      `  Turn ${ctx.turnNumber + 1}: send_message #${i + 1} (phase=${bandLabel()}, completedPlayerTurns=${ctx.completedPlayerTurns})`,
    );
    console.log(DIV);
    console.log(`  Player: ${truncate(content, 72)}`);

    exec = await runTurn(args, session.id, {
      type: "send_message",
      payload: { content },
    });
    reportTurn(ctx, exec);
    ctx.turnNumber += 1;

    // Refresh band + active set for next turn's expectation check
    const fresh = await httpGet<SessionRecord>(
      args.server,
      `/sessions/${session.id}`,
    );
    refreshSession(fresh);
  }

  // ── Phase 6: Final snapshot ────────────────────────────────────
  section("Phase 6: Final Session Snapshot");
  const snapshot = await httpGet<{
    session: { id: string };
    messages?: unknown[];
    characters?: unknown[];
    plugins?: Array<{ id: string; active: boolean }>;
  }>(args.server, `/sessions/${encodeURIComponent(session.id)}/view`);
  state.snapshot = snapshot;
  // The snapshot's `session` is the client-restore projection and omits
  // lifecycle fields. Read the live SessionRecord for
  // the authoritative lifecycle status + the final active set.
  const finalSession = await httpGet<SessionRecord>(
    args.server,
    `/sessions/${session.id}`,
  );
  refreshSession(finalSession);
  kv("Session ID", snapshot.session.id);
  kv("Status", finalSession.status);
  kv("Phase", finalSession.phase);
  kv("Completed player turns", finalSession.completedPlayerTurns);
  kv("Messages", snapshot.messages?.length ?? 0);
  kv("Characters", snapshot.characters?.length ?? 0);
  kv("Active plugins", snapshot.plugins?.filter((p) => p.active).length ?? 0);

  // Setup completion: setup-stage runtimes settle during the setup phase
  // (possibly inside the form-submit sub-execution the turn loop cannot read
  // back), so their authoritative "done" signal is their current
  // `session.setupRuntimes[runtimeId].state`, not the per-turn timeline.
  // Assert every active setup-stage runtime reached the done state.
  console.log("");
  console.log("  Setup Completion (setupRuntimes):");
  const setupRows: string[][] = [];
  for (const step of flow.steps) {
    if (step.stage !== "setup") continue;
    if (!runtimePasses(step, args.runtimeFilter, args.pluginFilter)) continue;
    if (!ctx.active.has(step.pluginId)) continue;
    const mirror = finalSession.setupRuntimes[step.runtimeId];
    const done = mirror?.state === "done";
    setupRows.push([
      done ? "PASS" : "FAIL",
      step.runtimeId,
      mirror
        ? `${mirror.state}${mirror.attempts !== undefined ? ` (attempts ${mirror.attempts})` : ""}`
        : "(not run)",
    ]);
    if (done) assertions.pass(`${step.runtimeId} setup complete`);
    else
      assertions.fail(
        `setup runtime ${step.runtimeId} did not complete during setup phase`,
      );
  }
  printTable(["result", "runtime", "state"], setupRows);

  // Background jobs: detached stages and background manual/event runtimes
  // finish outside the turns above. Wait for the queue to drain, then require
  // every job of the run to have succeeded (or been cancelled on purpose).
  console.log("");
  console.log("  Background Jobs (_runtime_jobs):");
  const ACTIVE_JOB_STATUSES = new Set([
    "queued",
    "claimed",
    "running",
    "committing",
  ]);
  const jobsDeadline = Date.now() + args.timeoutSec * 1000;
  let jobs: RuntimeJobRecord[] = [];
  for (;;) {
    jobs =
      (
        await httpGet<{ items: RuntimeJobRecord[] }>(
          args.server,
          `/sessions/${encodeURIComponent(session.id)}/runtime-jobs`,
        )
      ).items ?? [];
    if (
      !jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status)) ||
      Date.now() >= jobsDeadline
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const jobRows: string[][] = [];
  for (const job of jobs) {
    if (args.runtimeFilter && job.runtimeId !== args.runtimeFilter) continue;
    if (args.pluginFilter && !job.runtimeId.startsWith(`${args.pluginFilter}/`))
      continue;
    const ok = job.status === "succeeded" || job.status === "cancelled";
    jobRows.push([
      ok ? "PASS" : "FAIL",
      job.runtimeId,
      job.origin.activation,
      job.status,
      job.reason ?? job.error ?? "-",
    ]);
    if (ok) assertions.pass(`${job.runtimeId} job ${job.status}`);
    else
      assertions.fail(
        `background job ${job.runtimeId} (${job.jobId}) ended ${job.status}${job.reason ? `: ${job.reason}` : ""}`,
      );
  }
  if (jobRows.length > 0)
    printTable(
      ["result", "runtime", "activation", "status", "reason"],
      jobRows,
    );
  else console.log("  (none)");

  // Trace coverage: split guaranteed structural types from feature-conditional
  // ones. The LLM/message/proposal trio is required only when the active set
  // holds a story runtime (always true for real worlds; the guard keeps a
  // story-less config from failing). Conditional types (tool.*, block.emitted,
  // hook.fired) are reported, not required — hook.fired in particular fires
  // only when an active plugin declares a hook, which the default active set
  // does not. `args.server` already carries the `/api` prefix.
  const tracesBody = await httpGet<{
    events: Array<{
      eventOrder: number;
      type: string;
      payload: Record<string, unknown>;
    }>;
  }>(args.server, `/traces/${encodeURIComponent(session.id)}`);
  state.traces = tracesBody;
  const seenTypes = new Set(tracesBody.events.map((e) => e.type));

  // The models each runtime actually called, as the configuration (or the
  // --slot override) routed them.
  const modelsByRuntime = new Map<string, Set<string>>();
  for (const event of tracesBody.events) {
    if (event.type !== "llm.calling" && event.type !== "gateway.responded")
      continue;
    const { runtimeId, slot, provider, model } = event.payload;
    if (typeof runtimeId !== "string" || typeof model !== "string") continue;
    const route = `${typeof slot === "string" ? slot : "-"} → ${
      typeof provider === "string" ? `${provider}/` : ""
    }${model}`;
    const routes = modelsByRuntime.get(runtimeId) ?? new Set<string>();
    routes.add(route);
    modelsByRuntime.set(runtimeId, routes);
  }
  console.log("");
  console.log("  Models used (from traces):");
  printTable(
    ["runtime", "slot → model"],
    [...modelsByRuntime]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([runtimeId, routes]) => [runtimeId, [...routes].join(", ")]),
  );
  const hasActiveStory = flow.steps.some(
    (s) => ctx.active.has(s.pluginId) && s.isStoryRuntime,
  );
  const REQUIRED_TYPES = [
    "turn.started",
    "runtime.started",
    "runtime.completed",
    ...(hasActiveStory
      ? [
          "llm.calling",
          "llm.responded",
          "message.completed",
          "proposal.committed",
        ]
      : []),
  ];
  const INFORMATIONAL_TYPES = [
    "tool.calling",
    "tool.completed",
    "block.emitted",
    "hook.fired",
    "hook.rewrote",
    "hook.aborted",
  ];
  const missing = REQUIRED_TYPES.filter((t) => !seenTypes.has(t));
  for (const t of missing) {
    assertions.fail(`required trace type missing: ${t}`);
  }
  if (missing.length > 0) {
    console.error(`[e2e] missing required trace types: ${missing.join(", ")}`);
    console.error(
      `[e2e] seen types: ${Array.from(seenTypes).sort().join(", ")}`,
    );
  }
  const seenInfo = INFORMATIONAL_TYPES.filter((t) => seenTypes.has(t));
  console.log(
    `[e2e] trace coverage: ${seenTypes.size} distinct types; required ${
      missing.length === 0 ? "OK" : "MISSING"
    }; optional observed: ${seenInfo.join(", ") || "(none)"}`,
  );

  if (args.requireCompaction) {
    if (seenTypes.has("context.compacted")) {
      assertions.pass("context compaction observed");
    } else {
      assertions.fail("required context.compacted trace missing");
    }
  }

  if (args.requireSummaryUse) {
    const firstCompactionOrder = tracesBody.events.find(
      (event) => event.type === "context.compacted",
    )?.eventOrder;
    const summaryUsed = tracesBody.events.some(
      (event) =>
        firstCompactionOrder !== undefined &&
        event.eventOrder > firstCompactionOrder &&
        event.type === "llm.calling" &&
        JSON.stringify(event.payload).includes("<compacted_history>"),
    );
    if (summaryUsed) assertions.pass("compacted summary used by LLM prompt");
    else assertions.fail("no llm.calling prompt contained <compacted_history>");
  }

  for (const toolName of args.requireTools) {
    const completed = tracesBody.events.some(
      (event) =>
        event.type === "tool.completed" && event.payload.toolName === toolName,
    );
    if (completed) assertions.pass(`required tool completed: ${toolName}`);
    else assertions.fail(`required tool did not complete: ${toolName}`);
  }

  // A rejected tool call is sent again and leaves no stored record, so the
  // turn results show nothing. Each one costs a model round trip.
  const rejected = rejectedToolCalls(tracesBody.events);
  const rejectedTotal = rejected.reduce((sum, row) => sum + row.count, 0);
  console.log("");
  console.log(`  Rejected tool calls (from traces): ${rejectedTotal}`);
  if (rejected.length > 0) {
    printTable(
      ["count", "runtime", "tool", "error"],
      rejected.map((row) => [
        String(row.count),
        row.runtimeId,
        row.toolName,
        row.error,
      ]),
    );
    // A real model has a few rejected calls in every run, so this is a
    // warning. It fails only when rejections outnumber accepted calls: that
    // is no longer a model slip but a tool or prompt that cannot be satisfied.
    const acceptedTotal = tracesBody.events.filter(
      (event) => event.type === "tool.completed",
    ).length;
    if (rejectedTotal > acceptedTotal)
      assertions.fail(
        `${rejectedTotal} tool calls were rejected and only ${acceptedTotal} accepted`,
      );
    else
      assertions.warn(
        `${rejectedTotal} tool call(s) were rejected and sent again`,
      );
  }

  // What the models wrote must be in the session's language.
  if (args.languageCheck) {
    const language = outputLanguageReport(tracesBody.events, args.locale);
    console.log("");
    console.log(`  Output language (session locale ${args.locale}):`);
    printTable(
      ["result", "runtime", "prose values", "wrong language", "example"],
      language.map((row) => [
        languageVerdict(row).toUpperCase(),
        row.runtimeId,
        String(row.prose),
        String(row.wrong),
        row.examples[0] ?? "",
      ]),
    );
    for (const row of language) {
      const verdict = languageVerdict(row);
      const message = `${row.runtimeId} wrote ${row.wrong} of ${row.prose} prose values in the wrong language`;
      if (verdict === "fail") assertions.fail(message);
      else if (verdict === "warn") assertions.warn(message);
      else assertions.pass(`${row.runtimeId} output language`);
    }
  }

  // What the models were told should be in the session's language too. A
  // warning: a world with no edition in this language sends its own text.
  if (args.languageCheck) {
    const prompts = promptLanguageReport(tracesBody.events, args.locale);
    if (prompts.length > 0) {
      const total = prompts.reduce((sum, row) => sum + row.characters, 0);
      console.log("");
      console.log(
        `  Prompt language: ${total} Chinese, Japanese or Korean characters were sent to the model in a ${args.locale} session:`,
      );
      printTable(
        ["characters", "lines", "runtime", "example"],
        prompts.map((row) => [
          String(row.characters),
          String(row.lines),
          row.runtimeId,
          row.example,
        ]),
      );
      assertions.warn(
        `${total} characters in another script were sent to the model in a ${args.locale} session`,
      );
    } else if (!/^(zh|ja|ko)([-_]|$)/i.test(args.locale ?? ""))
      assertions.pass("prompt language");
  }

  if (args.strictTraces) {
    const failures = tracesBody.events.filter(
      (event) =>
        event.type.endsWith(".failed") ||
        event.type === "error.occurred" ||
        (event.type === "llm.responded" &&
          event.payload.finishReason === "error"),
    );
    if (failures.length === 0) assertions.pass("no failure traces observed");
    else {
      for (const failure of failures) {
        assertions.fail(
          `${failure.type}: ${String(failure.payload.error ?? "unknown")}`,
        );
      }
    }
  }

  if (args.maxInputTokens !== undefined) {
    const measuredInputTokens = tracesBody.events.flatMap((event) => {
      if (event.type !== "llm.responded") return [];
      const usage = event.payload.usage;
      if (!usage || typeof usage !== "object") return [];
      const inputTokens = (usage as Record<string, unknown>).inputTokens;
      return typeof inputTokens === "number" && Number.isFinite(inputTokens)
        ? [inputTokens]
        : [];
    });
    const overBudget = measuredInputTokens.filter(
      (inputTokens) => inputTokens > args.maxInputTokens!,
    );
    if (measuredInputTokens.length === 0) {
      assertions.fail("no provider-reported input token usage available");
    } else if (overBudget.length === 0) {
      assertions.pass(`all LLM inputs <= ${args.maxInputTokens}`);
    } else {
      const maxObserved = Math.max(...overBudget);
      assertions.fail(
        `${overBudget.length} LLM inputs exceeded ${args.maxInputTokens}; max=${maxObserved}`,
      );
    }
  }

  // ── Phase 7: Summary ───────────────────────────────────────────
  section("Phase 7: Summary");
  const turnsResp = await httpGet<{ items: TurnRecord[] }>(
    args.server,
    `/sessions/${session.id}/turns`,
  );
  const allTurns = turnsResp.items ?? [];
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

  // Run-level loose assertion for scheduled runtimes. Rather than re-simulate
  // interval/cooldown per turn, require each staged+active scheduled runtime
  // that had ≥1 in-band opportunity to have fired at least once across the
  // window. One that never fired is a real regression the per-turn checker
  // deliberately stays silent about.
  const scheduledNeverFired: string[] = [];
  for (const step of flow.steps) {
    if (!runtimePasses(step, args.runtimeFilter, args.pluginFilter)) continue;
    if (!ctx.scheduledOpportunity.has(step.runtimeId)) continue;
    if (ctx.scheduledFired.has(step.runtimeId)) continue;
    scheduledNeverFired.push(step.runtimeId);
    assertions.fail(
      `scheduled runtime ${step.runtimeId} never triggered across the run`,
    );
  }

  kv("Total turns", allTurns.length);
  kv(
    "Runtime runs",
    `${totalRunRuns} (ok=${successRuns} fail=${failRuns} skip=${skippedRuns})`,
  );
  kv(
    "Scheduled ≥1",
    `${ctx.scheduledFired.size}/${ctx.scheduledOpportunity.size} fired` +
      (scheduledNeverFired.length > 0
        ? ` (never: ${scheduledNeverFired.join(", ")})`
        : ""),
  );
  kv(
    "Tool calls",
    // `fail` counts stored failures; a rejected call was retried and is not stored.
    `${totalToolCalls} (ok=${successToolCalls} fail=${failToolCalls} rejected-and-retried=${rejectedTotal})`,
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
