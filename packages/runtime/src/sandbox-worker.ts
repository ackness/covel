import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES_LIMIT = 1024 * 1024;

export type SandboxWorkerErrorCode =
  | "timeout"
  | "aborted"
  | "output_too_large"
  | "invalid_output"
  | "runtime_error";

export class SandboxWorkerError extends Error {
  constructor(
    readonly code: SandboxWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxWorkerError";
  }
}

export interface SandboxWorkerOptions<I = unknown> {
  readonly code: string;
  readonly input: I;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

const WORKER_BOOTSTRAP_SCRIPT = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

function main() {
  const { code, inputJson, timeoutMs, maxOutputBytes } = workerData;
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  vm.runInContext(
    \`function __covelDeepFreeze(value) {
      if (value === null || typeof value !== "object") return value;
      Object.freeze(value);
      for (const key of Object.keys(value)) {
        __covelDeepFreeze(value[key]);
      }
      return value;
    }
    const __covelInput = __covelDeepFreeze(JSON.parse(\${JSON.stringify(inputJson)}));\`,
    context,
    { timeout: timeoutMs },
  );

  const fn = vm.compileFunction(\`"use strict";\\n\` + code, ["input"], {
    parsingContext: context,
  });

  Object.defineProperty(sandbox, "__covelFn", {
    value: fn,
    enumerable: false,
    configurable: true,
  });

  const serialized = vm.runInContext(
    \`(() => {
      const value = __covelFn(__covelInput);
      if (value === undefined) return undefined;
      return JSON.stringify(value);
    })()\`,
    context,
    { timeout: timeoutMs },
  );

  if (typeof serialized !== "string") {
    throw Object.assign(
      new Error("Sandbox worker must return a JSON-serializable value (not undefined)"),
      { covelCode: "invalid_output" },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes) {
    throw Object.assign(
      new Error(\`Sandbox worker output exceeded maxOutputBytes (\${maxOutputBytes})\`),
      { covelCode: "output_too_large" },
    );
  }
  parentPort.postMessage({ ok: true, json: serialized });
}

try {
  main();
} catch (error) {
  const errObj = error && typeof error === "object" ? error : {};
  const isTimeout =
    errObj.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ||
    errObj.covelCode === "timeout";
  const code = isTimeout
    ? "timeout"
    : typeof errObj.covelCode === "string"
      ? errObj.covelCode
      : "runtime_error";
  const message =
    error instanceof Error ? error.message : String(error ?? "Sandbox failed");
  parentPort.postMessage({ ok: false, code, message });
}
`;

export function runSandboxWorker<I = unknown, O = unknown>(
  options: SandboxWorkerOptions<I>,
): Promise<O> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new SandboxWorkerError("aborted", "Sandbox execution was aborted"),
    );
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify(options.input ?? null);
  } catch (error) {
    return Promise.reject(
      new SandboxWorkerError(
        "runtime_error",
        error instanceof Error
          ? `Sandbox input is not JSON-serializable: ${error.message}`
          : "Sandbox input is not JSON-serializable",
      ),
    );
  }
  if (typeof inputJson !== "string") {
    inputJson = "null";
  }

  const rawTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(
    10,
    Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)),
  );
  const rawMaxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxOutputBytes = Math.max(
    1,
    Math.min(MAX_OUTPUT_BYTES_LIMIT, Math.floor(rawMaxBytes)),
  );

  return new Promise<O>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_BOOTSTRAP_SCRIPT, {
      eval: true,
      workerData: {
        code: options.code,
        inputJson,
        timeoutMs,
        maxOutputBytes,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
      },
    });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      fn();
    };

    const fail = (err: SandboxWorkerError) => {
      settle(() => reject(err));
    };

    const onAbort = () => {
      fail(new SandboxWorkerError("aborted", "Sandbox execution was aborted"));
    };

    const timer = setTimeout(() => {
      fail(
        new SandboxWorkerError(
          "timeout",
          `Sandbox worker timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs + 250);
    timer.unref?.();

    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on(
      "message",
      (
        msg:
          | { readonly ok: true; readonly json: string }
          | {
              readonly ok: false;
              readonly code: SandboxWorkerErrorCode;
              readonly message: string;
            },
      ) => {
        settle(() => {
          if (!msg.ok) {
            reject(new SandboxWorkerError(msg.code, msg.message));
            return;
          }
          try {
            resolve(JSON.parse(msg.json) as O);
          } catch {
            reject(
              new SandboxWorkerError(
                "invalid_output",
                "Sandbox worker produced invalid JSON output",
              ),
            );
          }
        });
      },
    );

    worker.on("error", (error) => {
      fail(
        new SandboxWorkerError(
          "runtime_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    });

    worker.on("exit", (exitCode) => {
      if (settled) return;
      fail(
        new SandboxWorkerError(
          "runtime_error",
          `Sandbox worker exited unexpectedly with code ${exitCode}`,
        ),
      );
    });
  });
}
