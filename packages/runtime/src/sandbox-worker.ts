import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES_LIMIT = 1024 * 1024;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_WORKERS = 8;

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

  // Format any error thrown by untrusted code inside the VM context so hostile
  // getters or toString() traps stay bounded by the VM execution timeout.
  const outcome = vm.runInContext(
    \`(() => {
      try {
        const json = JSON.stringify(__covelFn(__covelInput));
        if (typeof json !== "string") return { kind: "invalid_output" };
        return { kind: "ok", json };
      } catch (err) {
        let message = "Sandbox failed";
        try {
          if (err && typeof err === "object" && typeof err.message === "string") {
            message = err.message;
          } else if (err !== undefined && err !== null) {
            message = String(err);
          }
        } catch {
          message = "Sandbox threw an unstringifiable error";
        }
        return { kind: "error", message: String(message).slice(0, 2048) };
      }
    })()\`,
    context,
    { timeout: timeoutMs },
  );

  if (outcome && typeof outcome === "object" && outcome.kind === "error") {
    throw Object.assign(
      new Error(typeof outcome.message === "string" ? outcome.message : "Sandbox failed"),
      { covelCode: "runtime_error" },
    );
  }
  const serialized =
    outcome && typeof outcome === "object" && outcome.kind === "ok"
      ? outcome.json
      : undefined;
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

function ownStringProp(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc && "value" in desc && typeof desc.value === "string"
    ? desc.value
    : undefined;
}

try {
  main();
} catch (error) {
  const errCode = ownStringProp(error, "code");
  const covelCode = ownStringProp(error, "covelCode");
  const isTimeout =
    errCode === "ERR_SCRIPT_EXECUTION_TIMEOUT" || covelCode === "timeout";
  const code = isTimeout ? "timeout" : covelCode ?? "runtime_error";
  const message = ownStringProp(error, "message") ?? "Sandbox failed";
  parentPort.postMessage({ ok: false, code, message });
}
`;

let activeWorkers = 0;
const waitQueue: Array<() => void> = [];

function acquireWorkerSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new SandboxWorkerError("aborted", "Sandbox execution was aborted"),
    );
  }
  if (activeWorkers < MAX_CONCURRENT_WORKERS) {
    activeWorkers += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      activeWorkers += 1;
      resolve();
    };
    const onAbort = () => {
      const idx = waitQueue.indexOf(grant);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(
        new SandboxWorkerError("aborted", "Sandbox execution was aborted"),
      );
    };
    waitQueue.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseWorkerSlot(): void {
  activeWorkers = Math.max(0, activeWorkers - 1);
  const next = waitQueue.shift();
  if (next) next();
}

export async function runSandboxWorker<I = unknown, O = unknown>(
  options: SandboxWorkerOptions<I>,
): Promise<O> {
  if (options.signal?.aborted) {
    throw new SandboxWorkerError("aborted", "Sandbox execution was aborted");
  }
  if (Buffer.byteLength(options.code, "utf8") > MAX_CODE_BYTES) {
    throw new SandboxWorkerError(
      "runtime_error",
      `Sandbox code exceeded maximum size (${MAX_CODE_BYTES} bytes)`,
    );
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify(options.input ?? null);
  } catch (error) {
    throw new SandboxWorkerError(
      "runtime_error",
      error instanceof Error
        ? `Sandbox input is not JSON-serializable: ${error.message}`
        : "Sandbox input is not JSON-serializable",
    );
  }
  if (typeof inputJson !== "string") {
    inputJson = "null";
  }
  if (Buffer.byteLength(inputJson, "utf8") > MAX_INPUT_BYTES) {
    throw new SandboxWorkerError(
      "runtime_error",
      `Sandbox input exceeded maximum size (${MAX_INPUT_BYTES} bytes)`,
    );
  }

  const rawTimeout =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(
    10,
    Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)),
  );
  const rawMaxBytes =
    typeof options.maxOutputBytes === "number" &&
    Number.isFinite(options.maxOutputBytes)
      ? options.maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES;
  const maxOutputBytes = Math.max(
    1,
    Math.min(MAX_OUTPUT_BYTES_LIMIT, Math.floor(rawMaxBytes)),
  );

  await acquireWorkerSlot(options.signal);

  return new Promise<O>((resolve, reject) => {
    let settled = false;
    let slotReleased = false;
    const releaseOnce = () => {
      if (slotReleased) return;
      slotReleased = true;
      releaseWorkerSlot();
    };

    let worker: Worker;
    try {
      worker = new Worker(WORKER_BOOTSTRAP_SCRIPT, {
        eval: true,
        env: {},
        execArgv: [],
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
    } catch (error) {
      releaseOnce();
      reject(
        new SandboxWorkerError(
          "runtime_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().finally(releaseOnce);
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
