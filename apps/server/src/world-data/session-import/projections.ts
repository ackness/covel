import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { WorldProjectionDecl } from "@covel/shared";
import {
  getPluginTrustInfo,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { canonicalJson, digestFile, sha256Hex } from "../digest.js";
import { resolveContainedPath } from "../safe-path.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "../types.js";
import { isRecord } from "./utils.js";
import {
  preflightPluginTarget,
  validatePluginDataValue,
} from "./validation.js";
import type {
  DeferredProjectionOutput,
  PlannedWrite,
  PluginDataTarget,
  WorldDataImportPreflightDeps,
} from "./types.js";

interface ActiveWorldProjection {
  readonly pluginId: string;
  readonly projectionId: string;
  readonly entry: PluginRegistryEntry;
  readonly declaration: WorldProjectionDecl;
}

interface WorldProjectionHandlerInput {
  readonly value: unknown;
  readonly context: {
    readonly sessionId: string;
    readonly worldId: string;
    readonly sourceId: string;
    readonly locale?: string;
    readonly now: string;
  };
}

const PROJECTION_TIMEOUT_MS = 1_000;
const MAX_PROJECTION_OUTPUT_BYTES = 1_048_576;
const MAX_PROJECTED_ITEMS_PER_OUTPUT = 1_000;
const MAX_PROJECTIONS_PER_SOURCE = 32;
const PROJECTION_WORKER_MAX_OLD_GENERATION_MB = 128;
const PROJECTION_WORKER_MAX_YOUNG_GENERATION_MB = 32;
const PROJECTION_WORKER_STACK_MB = 4;

interface ResolvedProjectionHandler {
  readonly path: string;
  readonly url: string;
  readonly digest: string;
}

type ProjectionWorkerMessage =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: string };

// Each invocation gets a fresh worker. Besides enforcing a hard timeout, that
// gives every projection its own input clone and module graph: one plugin
// cannot mutate another projection's source object or retain globals across
// sessions. JSON serialization inside the worker is the output trust boundary.
const PROJECTION_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const mod = await import(workerData.handlerUrl);
  if (typeof mod.default !== "function") {
    throw new Error("handler module must default-export a function");
  }
  const result = await mod.default(workerData.input);
  const json = JSON.stringify(result);
  if (json === undefined) {
    throw new Error("handler result is not JSON-serializable");
  }
  if (Buffer.byteLength(json, "utf8") > workerData.maxOutputBytes) {
    throw new Error("handler result exceeds the configured output budget");
  }
  parentPort.postMessage({ ok: true, json });
})().catch((error) => {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
});
`;

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasProjectionEffect(source: OrderedWorldDataSource): boolean {
  return source.descriptor.effects?.includes("projections") === true;
}

function activeWorldProjections(options: {
  readonly source: OrderedWorldDataSource;
  readonly deps?: WorldDataImportPreflightDeps;
}): readonly ActiveWorldProjection[] {
  if (!hasProjectionEffect(options.source)) return [];
  const sourceSchema = options.source.descriptor.schema;
  if (!sourceSchema || !options.deps?.registry) return [];

  const projections: ActiveWorldProjection[] = [];
  const activePluginIds = [...new Set(options.deps.activePlugins ?? [])].sort(
    compareAscii,
  );
  for (const pluginId of activePluginIds) {
    const entry = options.deps.registry.get(pluginId);
    if (!entry) continue;
    for (const [projectionId, declaration] of Object.entries(
      entry.worldProjections ?? {},
    ).sort(([left], [right]) => compareAscii(left, right))) {
      if (declaration.from !== sourceSchema) continue;
      projections.push({ pluginId, projectionId, entry, declaration });
    }
  }
  return projections;
}

function projectionLabel(projection: ActiveWorldProjection): string {
  return `world projection "${projection.pluginId}/${projection.projectionId}"`;
}

function projectionDiagnostic(options: {
  readonly source: OrderedWorldDataSource;
  readonly projection: ActiveWorldProjection;
  readonly message: string;
}): WorldDataDiagnostic {
  return {
    // A projection is an optional derived view. Its failure must not prevent
    // the source's canonical world-data write or another plugin's projection.
    level: "warning",
    sourceId: options.source.id,
    schema: options.source.descriptor.schema,
    message: `${projectionLabel(options.projection)} ${options.message}`,
  };
}

function deferredProjectionOutput(
  source: OrderedWorldDataSource,
  projection: ActiveWorldProjection,
  outputId: string,
): DeferredProjectionOutput {
  return {
    sourceId: source.id,
    pluginId: projection.pluginId,
    projectionId: projection.projectionId,
    outputId,
  };
}

async function resolveProjectionHandler(options: {
  readonly source: OrderedWorldDataSource;
  readonly projection: ActiveWorldProjection;
}): Promise<
  | { readonly handler: ResolvedProjectionHandler }
  | { readonly diagnostic: WorldDataDiagnostic }
> {
  const { source, projection } = options;
  if (!projection.entry.rootPath) {
    return {
      diagnostic: projectionDiagnostic({
        source,
        projection,
        message: "cannot resolve its handler without a plugin root path",
      }),
    };
  }
  let handlerPath: string | null;
  try {
    handlerPath = await resolveContainedPath(
      projection.entry.rootPath,
      projection.declaration.handler,
      { rejectSymlinks: true },
    );
  } catch (error) {
    return {
      diagnostic: projectionDiagnostic({
        source,
        projection,
        message: `handler "${projection.declaration.handler}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
  if (!handlerPath) {
    return {
      diagnostic: projectionDiagnostic({
        source,
        projection,
        message: `handler "${projection.declaration.handler}" is missing, invalid, or escapes the plugin root`,
      }),
    };
  }

  try {
    return {
      handler: {
        path: handlerPath,
        url: pathToFileURL(handlerPath).href,
        digest: (await digestFile(handlerPath)).digest,
      },
    };
  } catch (error) {
    return {
      diagnostic: projectionDiagnostic({
        source,
        projection,
        message: `handler "${projection.declaration.handler}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }),
    };
  }
}

async function runProjectionHandler(
  handler: ResolvedProjectionHandler,
  input: WorldProjectionHandlerInput,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROJECTION_WORKER_SOURCE, {
      eval: true,
      workerData: {
        handlerUrl: handler.url,
        input,
        maxOutputBytes: MAX_PROJECTION_OUTPUT_BYTES,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: PROJECTION_WORKER_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: PROJECTION_WORKER_MAX_YOUNG_GENERATION_MB,
        stackSizeMb: PROJECTION_WORKER_STACK_MB,
      },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`timed out after ${PROJECTION_TIMEOUT_MS}ms`)),
      );
    }, PROJECTION_TIMEOUT_MS);
    timer.unref();

    worker.once("message", (message: ProjectionWorkerMessage) => {
      if (!message || typeof message !== "object") {
        finish(() => reject(new Error("handler worker returned no result")));
        return;
      }
      if (!message.ok) {
        finish(() => reject(new Error(message.error)));
        return;
      }
      if (
        typeof message.json !== "string" ||
        Buffer.byteLength(message.json, "utf8") > MAX_PROJECTION_OUTPUT_BYTES
      ) {
        finish(() =>
          reject(
            new Error(
              "handler worker returned an invalid or oversized payload",
            ),
          ),
        );
        return;
      }
      finish(() => {
        try {
          resolve(JSON.parse(message.json) as unknown);
        } catch (error) {
          reject(
            new Error(
              `handler worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `handler worker exited with code ${code} before replying`,
            ),
          ),
        );
      }
    });
  });
}

function projectionTarget(
  pluginId: string,
  namespace: string,
): PluginDataTarget {
  return {
    kind: "plugin-data",
    pluginId,
    namespace,
    lorebook: false,
  };
}

function projectedKey(options: {
  readonly item: unknown;
  readonly keyField: string;
}): string | null {
  if (!isRecord(options.item)) return null;
  const value = options.item[options.keyField];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export async function executeWorldProjections(options: {
  readonly source: OrderedWorldDataSource;
  readonly sourceDigest: string;
  readonly value: unknown;
  readonly sessionId: string;
  readonly worldId: string;
  readonly locale?: string;
  readonly now: string;
  readonly deps?: WorldDataImportPreflightDeps;
}): Promise<{
  readonly writes: readonly PlannedWrite[];
  readonly diagnostics: readonly WorldDataDiagnostic[];
  readonly deferredProjectionOutputs: readonly DeferredProjectionOutput[];
}> {
  const writes: PlannedWrite[] = [];
  const diagnostics: WorldDataDiagnostic[] = [];
  const deferredProjectionOutputs: DeferredProjectionOutput[] = [];

  const activeProjections = activeWorldProjections(options);
  if (activeProjections.length > MAX_PROJECTIONS_PER_SOURCE) {
    diagnostics.push({
      level: "warning",
      sourceId: options.source.id,
      schema: options.source.descriptor.schema,
      message: `worldData source "${options.source.id}" matched ${activeProjections.length} projections; only the first ${MAX_PROJECTIONS_PER_SOURCE} in stable plugin/projection order will run`,
    });
    for (const projection of activeProjections.slice(
      MAX_PROJECTIONS_PER_SOURCE,
    )) {
      for (const outputId of Object.keys(projection.declaration.outputs)) {
        deferredProjectionOutputs.push(
          deferredProjectionOutput(options.source, projection, outputId),
        );
      }
    }
  }
  for (const projection of activeProjections.slice(
    0,
    MAX_PROJECTIONS_PER_SOURCE,
  )) {
    const outputEntries = Object.entries(projection.declaration.outputs).sort(
      ([left], [right]) => compareAscii(left, right),
    );
    let projectionHasPreflightError = false;
    for (const [, output] of outputEntries) {
      const targetDiagnostics = preflightPluginTarget(
        projectionTarget(projection.pluginId, output.namespace),
        options.source,
        options.deps,
      );
      diagnostics.push(
        ...targetDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          level: "warning" as const,
          message: `${projectionLabel(projection)} ${diagnostic.message}`,
        })),
      );
      if (
        targetDiagnostics.some((diagnostic) => diagnostic.level === "error")
      ) {
        projectionHasPreflightError = true;
      }
    }
    if (projectionHasPreflightError) {
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    if (options.deps?.executeProjectionHandlers === false) {
      diagnostics.push({
        level: "warning",
        sourceId: options.source.id,
        schema: options.source.descriptor.schema,
        message: `${projectionLabel(projection)} handler execution is deferred in read-only preflight; output keys are available only during import or sync`,
      });
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    const trust = getPluginTrustInfo(
      projection.pluginId,
      projection.entry.source,
    );
    if (
      trust.requiresApproval &&
      options.deps?.canExecuteProjection?.(projection.pluginId) !== true
    ) {
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message:
            "community handler execution requires an explicit session server-code approval",
        }),
      );
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    const loaded = await resolveProjectionHandler({
      source: options.source,
      projection,
    });
    if ("diagnostic" in loaded) {
      diagnostics.push(loaded.diagnostic);
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    let result: unknown;
    try {
      result = await runProjectionHandler(loaded.handler, {
        value: options.value,
        context: {
          sessionId: options.sessionId,
          worldId: options.worldId,
          sourceId: options.source.id,
          ...(options.locale ? { locale: options.locale } : {}),
          now: options.now,
        },
      });
    } catch (error) {
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message: `handler failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    try {
      const executedDigest = (await digestFile(loaded.handler.path)).digest;
      if (executedDigest !== loaded.handler.digest) {
        diagnostics.push(
          projectionDiagnostic({
            source: options.source,
            projection,
            message:
              "handler changed during execution; its output was discarded so provenance cannot become stale",
          }),
        );
        deferredProjectionOutputs.push(
          ...outputEntries.map(([outputId]) =>
            deferredProjectionOutput(options.source, projection, outputId),
          ),
        );
        continue;
      }
    } catch (error) {
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message: `handler could not be re-read after execution: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    if (!isRecord(result)) {
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message: "handler must return an object keyed by declared output id",
        }),
      );
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    const declaredOutputIds = new Set(
      outputEntries.map(([outputId]) => outputId),
    );
    const returnedOutputIds = Object.keys(result).sort(compareAscii);
    let outputShapeError = false;
    for (const outputId of outputEntries.map(([id]) => id)) {
      if (Object.prototype.hasOwnProperty.call(result, outputId)) continue;
      outputShapeError = true;
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message: `did not return declared output "${outputId}"`,
        }),
      );
    }
    for (const outputId of returnedOutputIds) {
      if (declaredOutputIds.has(outputId)) continue;
      outputShapeError = true;
      diagnostics.push(
        projectionDiagnostic({
          source: options.source,
          projection,
          message: `returned undeclared output "${outputId}"`,
        }),
      );
    }
    if (outputShapeError) {
      deferredProjectionOutputs.push(
        ...outputEntries.map(([outputId]) =>
          deferredProjectionOutput(options.source, projection, outputId),
        ),
      );
      continue;
    }

    for (const [outputId, output] of outputEntries) {
      const target = projectionTarget(projection.pluginId, output.namespace);
      const targetUri = `plugin:${projection.pluginId}/${output.namespace}`;
      const outputWrites: PlannedWrite[] = [];
      let outputFailed = false;
      const items = Array.isArray(result[outputId])
        ? result[outputId]
        : [result[outputId]];
      if (items.length > MAX_PROJECTED_ITEMS_PER_OUTPUT) {
        diagnostics.push(
          projectionDiagnostic({
            source: options.source,
            projection,
            message: `output "${outputId}" has ${items.length} items; maximum is ${MAX_PROJECTED_ITEMS_PER_OUTPUT}`,
          }),
        );
        deferredProjectionOutputs.push(
          deferredProjectionOutput(options.source, projection, outputId),
        );
        continue;
      }
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        const key = projectedKey({ item, keyField: output.key });
        if (!key) {
          outputFailed = true;
          diagnostics.push(
            projectionDiagnostic({
              source: options.source,
              projection,
              message: `output "${outputId}" item ${itemIndex} needs a string or finite number in key field "${output.key}"`,
            }),
          );
          deferredProjectionOutputs.push(
            deferredProjectionOutput(options.source, projection, outputId),
          );
          continue;
        }

        let validationError: WorldDataDiagnostic | null;
        try {
          validationError = await validatePluginDataValue({
            target,
            source: options.source,
            value: item,
            schema: null,
            deps: options.deps,
          });
        } catch (error) {
          outputFailed = true;
          diagnostics.push(
            projectionDiagnostic({
              source: options.source,
              projection,
              message: `output "${outputId}" target schema failed to load or compile: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
          deferredProjectionOutputs.push(
            deferredProjectionOutput(options.source, projection, outputId),
          );
          continue;
        }
        if (validationError) {
          outputFailed = true;
          diagnostics.push({
            ...validationError,
            level: "warning",
            message: `${projectionLabel(projection)} output "${outputId}" ${validationError.message}`,
          });
          deferredProjectionOutputs.push(
            deferredProjectionOutput(options.source, projection, outputId),
          );
          continue;
        }

        outputWrites.push({
          kind: "plugin-data",
          target: targetUri,
          source: options.source,
          // A projection is derived from source + handler + declaration +
          // actual item. Sync must not call it "unchanged" when plugin code,
          // locale/context, or output changes while the source file does not.
          sourceDigest: sha256Hex(
            canonicalJson({
              sourceDigest: options.sourceDigest,
              handlerDigest: loaded.handler.digest,
              projectionId: projection.projectionId,
              outputId,
              item,
            }),
          ),
          pluginId: projection.pluginId,
          namespace: output.namespace,
          key,
          value: item,
          derivedFrom: [
            options.source.id,
            `projection:${projection.pluginId}/${projection.projectionId}`,
            `output:${outputId}`,
          ],
        });
      }
      // One declared output is one consistency unit. Applying only its valid
      // items while preserving stale rows for invalid items produces a mixed
      // generation that no handler ever returned. Defer the complete output
      // instead; other declared outputs from the same projection may still
      // proceed independently.
      if (!outputFailed) writes.push(...outputWrites);
    }
  }

  const uniqueDeferredOutputs = new Map(
    deferredProjectionOutputs.map((output) => [
      `${output.sourceId}\u0000${output.pluginId}\u0000${output.projectionId}\u0000${output.outputId}`,
      output,
    ]),
  );
  return {
    writes,
    diagnostics,
    deferredProjectionOutputs: [...uniqueDeferredOutputs.values()],
  };
}
