import { resolve, extname } from "node:path";
import type { ScriptHostService, ScriptExecInput, ScriptExecResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Script execution service.
 * - .js/.mjs → Node.js worker_threads
 * - .py → child_process.spawn
 */
export function createScriptHostService(): ScriptHostService {
  async function exec(input: ScriptExecInput): Promise<ScriptExecResult> {
    const start = Date.now();

    // Path security: resolve and verify the script is inside scriptsDir
    const resolved = resolve(input.scriptsDir, input.script);
    const normalizedDir = resolve(input.scriptsDir);
    if (!resolved.startsWith(normalizedDir + "/") && resolved !== normalizedDir) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        error: `Script path "${input.script}" escapes scripts directory.`,
      };
    }

    const ext = extname(resolved).toLowerCase();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      if (ext === ".js" || ext === ".mjs") {
        return await execJsWorker(resolved, input.args, timeoutMs, start);
      } else if (ext === ".py") {
        return await execPython(resolved, input.args, timeoutMs, start);
      } else {
        return {
          success: false,
          output: null,
          durationMs: Date.now() - start,
          error: `Unsupported script extension: ${ext}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { exec };
}

async function execJsWorker(
  scriptPath: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  start: number,
): Promise<ScriptExecResult> {
  const { Worker } = await import("node:worker_threads");

  return new Promise<ScriptExecResult>((resolve) => {
    const worker = new Worker(scriptPath, {
      workerData: args,
    });

    const timer = setTimeout(() => {
      worker.terminate();
      resolve({
        success: false,
        output: null,
        durationMs: Date.now() - start,
        error: `Script timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    worker.on("message", (msg) => {
      clearTimeout(timer);
      resolve({
        success: true,
        output: msg,
        durationMs: Date.now() - start,
      });
      worker.terminate();
    });

    worker.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        output: null,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          success: false,
          output: null,
          durationMs: Date.now() - start,
          error: `Worker exited with code ${code}.`,
        });
      }
    });
  });
}

async function execPython(
  scriptPath: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  start: number,
): Promise<ScriptExecResult> {
  const { spawn } = await import("node:child_process");

  return new Promise<ScriptExecResult>((resolve) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Send args as JSON to stdin
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    proc.on("close", (code) => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        let output: unknown;
        try {
          output = JSON.parse(stdout);
        } catch {
          output = stdout.trim();
        }
        resolve({ success: true, output, durationMs });
      } else {
        resolve({
          success: false,
          output: null,
          durationMs,
          error: stderr || `Python exited with code ${code}.`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        output: null,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}
