/**
 * Tee stdout/stderr to a rolling NDJSON file (`server.log`) without
 * disturbing the terminal stream. Each output line becomes one JSON
 * record `{ ts, level, source, msg }`.
 *
 * Activation rules (decided in `dev-home-bootstrap.ts`):
 *   - Skip when `COVEL_DESKTOP_REST=true` or `1`. The packaged desktop already
 *     captures the sidecar's stdout/stderr from outside and writes its
 *     own `server.log` — we don't want a double-write.
 *   - Skip when `NODE_ENV=production`: the bootstrap that enables the tee
 *     does nothing in production.
 *   - Otherwise write to `<COVEL_LOGS_DIR>/server.log`, falling back to
 *     `<COVEL_HOME>/data/logs/server.log` when only `COVEL_HOME` is set.
 *
 * Business trace events (LLM calls, proposals, tool calls) are
 * intentionally NOT mirrored here — they live in the `trace_events`
 * table and are surfaced via `/debug` and the JSON export.
 */

import fs from "node:fs";
import path from "node:path";

interface RotationConfig {
  readonly maxSizeMb: number;
  readonly maxFiles: number;
}

interface TeeChannel {
  readonly filePath: string;
  stream: fs.WriteStream;
  bytesWritten: number;
}

let activeChannel: TeeChannel | null = null;
let maxBytes = 10 * 1024 * 1024;
let maxFiles = 10;
let rotating = false;
let rawStdoutWrite: NodeJS.WriteStream["write"] | null = null;
let rawStderrWrite: NodeJS.WriteStream["write"] | null = null;
let streamsWrapped = false;
const SERVER_WARNING_PREFIX = "[covel:warn]";

function writeRawStderr(message: string): void {
  const writer = rawStderrWrite ?? process.stderr.write.bind(process.stderr);
  try {
    writer(message);
  } catch {
    // Best-effort diagnostics only.
  }
}

function attachStreamErrorHandler(
  ch: TeeChannel,
  stream: fs.WriteStream,
): void {
  stream.on("error", (err) => {
    if (activeChannel === ch && ch.stream === stream) {
      activeChannel = null;
    }
    writeRawStderr(`[server-log-tee] stream error: ${String(err)}\n`);
  });
}

function openChannel(filePath: string): TeeChannel {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let bytesWritten = 0;
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  const channel: TeeChannel = {
    filePath,
    stream,
    bytesWritten,
  };
  attachStreamErrorHandler(channel, stream);
  return channel;
}

function rotateChannel(ch: TeeChannel): void {
  rotating = true;
  try {
    ch.stream.end();
    for (let i = maxFiles - 1; i >= 1; i--) {
      const older = `${ch.filePath}.${i}`;
      const newer = i === 1 ? ch.filePath : `${ch.filePath}.${i - 1}`;
      if (fs.existsSync(newer)) {
        if (i === maxFiles - 1 && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        try {
          fs.renameSync(newer, older);
        } catch {
          // ignore rename failures (cross-fs etc.) — next write retries
        }
      }
    }
    const nextStream = fs.createWriteStream(ch.filePath, { flags: "a" });
    attachStreamErrorHandler(ch, nextStream);
    ch.stream = nextStream;
    ch.bytesWritten = 0;
  } catch (err) {
    // Detach the channel so subsequent writes never hit an ended stream or
    // re-enter rotation, and write directly to the unwrapped stderr handle.
    if (activeChannel === ch) {
      activeChannel = null;
    }
    writeRawStderr(`[server-log-tee] rotation failed: ${String(err)}\n`);
  } finally {
    rotating = false;
  }
}

/**
 * Strip CSI / SGR escape sequences from a log line before persisting it.
 *
 * The terminal stream is left untouched (we still call `original.write()`
 * with the original chunk), so colours remain visible in the dev console;
 * only the file copy is sanitised. Pattern matches `ESC [ … final-byte`
 * (7-bit CSI) and the rare 8-bit CSI form `\u009B [ … final-byte`,
 * covering SGR (colour), cursor moves, and erase-line escapes — the full
 * vocabulary Hono's logger and our own console output emit.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

function appendNdjson(source: "stdout" | "stderr", line: string): void {
  if (!activeChannel || rotating) return;
  if (!line || !line.trim()) return;
  const classified = classifyServerStreamLine(source, line);
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    level: classified.level,
    source,
    msg: stripAnsi(classified.message),
  });
  const buf = record + "\n";
  const byteLen = Buffer.byteLength(buf, "utf8");
  if (activeChannel.bytesWritten + byteLen > maxBytes) {
    rotateChannel(activeChannel);
  }
  const channel = activeChannel;
  if (!channel || channel.stream.writableEnded || channel.stream.destroyed) {
    return;
  }
  channel.stream.write(buf);
  channel.bytesWritten += byteLen;
}

/**
 * Wrap a stream's `write` so every flushed line lands in `server.log`
 * via `appendNdjson(source, line)`. Multi-line writes are split
 * on `\n`; partial lines are buffered until a newline arrives so a JSON
 * record never contains half a console message.
 */
function wrapStream(
  stream: NodeJS.WriteStream,
  source: "stdout" | "stderr",
): NodeJS.WriteStream["write"] {
  const original = stream.write.bind(stream);
  let pending = "";
  // Cast through `unknown` because Node's `write` is overloaded and we
  // need a uniform signature for the proxy.
  const proxy = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
          );
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      appendNdjson(source, line);
    }
    if (typeof encodingOrCb === "function") {
      return original(chunk as never, encodingOrCb);
    }
    if (typeof encodingOrCb === "string") {
      return original(chunk as never, encodingOrCb, cb);
    }
    return original(chunk as never);
  }) as NodeJS.WriteStream["write"];
  stream.write = proxy;
  return original;
}

export interface SetupServerLogFileOptions {
  readonly filePath: string;
  readonly rotation?: Partial<RotationConfig>;
}

export function classifyServerStreamLine(
  source: "stdout" | "stderr",
  line: string,
): {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
} {
  if (source === "stdout") return { level: "info", message: line };
  const trimmed = line.trimStart();
  if (trimmed.startsWith(SERVER_WARNING_PREFIX)) {
    return {
      level: "warn",
      message: trimmed.slice(SERVER_WARNING_PREFIX.length).trimStart(),
    };
  }
  return { level: "error", message: line };
}

/**
 * Install the tee. Idempotent — calling twice is a no-op after the first.
 * The caller is responsible for deciding whether to call it (see module
 * docs for activation rules).
 */
export function setupServerLogFile(options: SetupServerLogFileOptions): void {
  if (activeChannel) return;
  if (options.rotation?.maxSizeMb) {
    maxBytes = Math.max(1, options.rotation.maxSizeMb) * 1024 * 1024;
  }
  if (options.rotation?.maxFiles) {
    maxFiles = Math.max(1, options.rotation.maxFiles);
  }
  try {
    activeChannel = openChannel(options.filePath);
  } catch (err) {
    writeRawStderr(
      `[server-log-tee] could not open ${options.filePath}: ${String(err)}\n`,
    );
    return;
  }
  if (!streamsWrapped) {
    rawStdoutWrite = wrapStream(process.stdout, "stdout");
    rawStderrWrite = wrapStream(process.stderr, "stderr");
    streamsWrapped = true;
  }
}

/** Test-only cleanup: restore process streams and close the active log channel. */
export function resetServerLogFileForTests(): void {
  const ch = activeChannel;
  activeChannel = null;
  rotating = false;
  if (ch && !ch.stream.destroyed) {
    ch.stream.end();
  }
  if (streamsWrapped) {
    if (rawStdoutWrite) process.stdout.write = rawStdoutWrite;
    if (rawStderrWrite) process.stderr.write = rawStderrWrite;
    rawStdoutWrite = null;
    rawStderrWrite = null;
    streamsWrapped = false;
  }
  maxBytes = 10 * 1024 * 1024;
  maxFiles = 10;
}
