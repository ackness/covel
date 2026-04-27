/**
 * Tee stdout/stderr to a rolling NDJSON file (`server.log`) without
 * disturbing the terminal stream. Each output line becomes one JSON
 * record `{ ts, level, source, msg }`.
 *
 * Activation rules (decided in `dev-home-bootstrap.ts`):
 *   - Skip when `COVEL_DESKTOP_REST=1`. The packaged desktop already
 *     captures the sidecar's stdout/stderr from outside and writes its
 *     own `server.log` — we don't want a double-write.
 *   - Skip when `NODE_ENV=production` and no explicit
 *     `COVEL_SERVER_LOG_FILE` is provided.
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

function openChannel(filePath: string): TeeChannel {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let bytesWritten = 0;
  try {
    bytesWritten = fs.statSync(filePath).size;
  } catch {
    bytesWritten = 0;
  }
  return {
    filePath,
    stream: fs.createWriteStream(filePath, { flags: "a" }),
    bytesWritten,
  };
}

function rotateChannel(ch: TeeChannel): void {
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
    ch.stream = fs.createWriteStream(ch.filePath, { flags: "a" });
    ch.bytesWritten = 0;
  } catch (err) {
    // Failing to rotate must never crash the server. Surface to stderr
    // (which is also being teed — but a write failure is rare and the
    // tee is best-effort by design).
    process.stderr.write(`[server-log-tee] rotation failed: ${String(err)}\n`);
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

function appendNdjson(level: "info" | "error", source: "stdout" | "stderr", line: string): void {
  if (!activeChannel) return;
  if (!line || !line.trim()) return;
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source,
    msg: stripAnsi(line),
  });
  const buf = record + "\n";
  const byteLen = Buffer.byteLength(buf, "utf8");
  if (activeChannel.bytesWritten + byteLen > maxBytes) {
    rotateChannel(activeChannel);
  }
  activeChannel.stream.write(buf);
  activeChannel.bytesWritten += byteLen;
}

/**
 * Wrap a stream's `write` so every flushed line lands in `server.log`
 * via `appendNdjson(level, source, line)`. Multi-line writes are split
 * on `\n`; partial lines are buffered until a newline arrives so a JSON
 * record never contains half a console message.
 */
function wrapStream(
  stream: NodeJS.WriteStream,
  level: "info" | "error",
  source: "stdout" | "stderr",
): void {
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
      appendNdjson(level, source, line);
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
}

export interface SetupServerLogFileOptions {
  readonly filePath: string;
  readonly rotation?: Partial<RotationConfig>;
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
    process.stderr.write(
      `[server-log-tee] could not open ${options.filePath}: ${String(err)}\n`,
    );
    return;
  }
  wrapStream(process.stdout, "info", "stdout");
  wrapStream(process.stderr, "error", "stderr");
}
