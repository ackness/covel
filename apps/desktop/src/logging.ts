import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogRotation {
  readonly maxSizeMb: number;
  readonly maxFiles: number;
}

interface LogChannel {
  readonly filePath: string;
  stream: fs.WriteStream | null;
  bytesWritten: number;
}

let desktopChannel: LogChannel | null = null;
let serverChannel: LogChannel | null = null;
let logMaxBytes = 10 * 1024 * 1024; // default 10MB per file
let logMaxFiles = 10;

function openChannel(filePath: string): LogChannel {
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

function rotateChannel(ch: LogChannel): void {
  try {
    ch.stream?.end();
    for (let i = logMaxFiles - 1; i >= 1; i--) {
      const older = `${ch.filePath}.${i}`;
      const newer = i === 1 ? ch.filePath : `${ch.filePath}.${i - 1}`;
      if (fs.existsSync(newer)) {
        if (i === logMaxFiles - 1 && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        try {
          fs.renameSync(newer, older);
        } catch {
          // rename across directories shouldn't happen here; ignore
        }
      }
    }
    ch.stream = fs.createWriteStream(ch.filePath, { flags: "a" });
    ch.bytesWritten = 0;
  } catch (err) {
    console.error(`[desktop] log rotation failed for ${ch.filePath}:`, err);
  }
}

function writeChannel(ch: LogChannel | null, ndjsonLine: string): void {
  if (!ch || !ch.stream) return;
  const buf = ndjsonLine + "\n";
  const byteLen = Buffer.byteLength(buf, "utf8");
  if (ch.bytesWritten + byteLen > logMaxBytes) {
    rotateChannel(ch);
  }
  ch.stream?.write(buf);
  ch.bytesWritten += byteLen;
}

/**
 * Strip CSI / SGR escape sequences before persisting a line. The terminal
 * forwards (`process.stdout.write` / `console.*`) keep the original
 * coloured text — only the file copy is sanitised so `jq` / log viewers
 * see a clean `msg` field.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Render an NDJSON line. Each record carries a stable shape so downstream
 * `jq` / log viewers can filter by level/source without parsing free text.
 */
function ndjsonLine(
  level: LogLevel,
  source: "desktop" | "server" | "server.err",
  msg: string,
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    source,
    msg: stripAnsi(msg),
  });
}

export function initPersistentLog(
  logsDir: string,
  rotation: LogRotation,
  appVersion: string,
): void {
  try {
    logMaxBytes = Math.max(1, rotation.maxSizeMb) * 1024 * 1024;
    logMaxFiles = Math.max(1, rotation.maxFiles);
    desktopChannel = openChannel(path.join(logsDir, "desktop.log"));
    serverChannel = openChannel(path.join(logsDir, "server.log"));
    writeLog("info", `--- Covel desktop start (v${appVersion}) ---`);
  } catch (err) {
    console.error("[desktop] Could not open log files:", err);
  }
}

export function writeLog(level: LogLevel, ...parts: unknown[]): void {
  const msg = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  // Pretty for stdout / dev terminal — keeps `pnpm dev:electron` readable.
  const pretty = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  switch (level) {
    case "error":
      console.error(pretty);
      break;
    case "warn":
      console.warn(pretty);
      break;
    default:
      console.log(pretty);
  }
  writeChannel(desktopChannel, ndjsonLine(level, "desktop", msg));
}

/**
 * Persist a sidecar stdout/stderr line to `server.log` only.
 * The desktop channel intentionally stays clean of sidecar chatter.
 */
export function writeServerStreamLine(
  origin: "stdout" | "stderr",
  line: string,
): void {
  if (!line || !line.trim()) return;
  const level: LogLevel = origin === "stderr" ? "error" : "info";
  const source = origin === "stderr" ? "server.err" : "server";
  writeChannel(serverChannel, ndjsonLine(level, source, line));
}
