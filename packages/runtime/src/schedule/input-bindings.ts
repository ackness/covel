/**
 * Runtime input bindings (`inputs`) — resolution, provenance, and gating
 * (docs 02 §3, 01 §4).
 *
 * A binding pulls a same-execution value from an upstream producer's success
 * result and injects it — wrapped in provenance (`InputSlot`) — into the
 * consumer's function `ctx.inputs` / agent prompt. `required: true` (default)
 * makes the binding a turn gate: unsatisfiable → the consumer is skipped with a
 * machine-readable reason; `required: false` is best-effort (omit the slot).
 *
 * Activation projection (01 §4): a `manual` activation ignores turn bindings
 * entirely (the target runs on `ctx.activation.payload`); a `detached`
 * activation that still carries turn bindings is rejected for THIS activation
 * without making the spec illegal. The recurrently-detached loader check
 * (`hasIllegalDetachedContract`) is the static twin.
 */

import type {
  JsonValue,
  RuntimeActivation,
  RuntimeBinding,
  RuntimeExportBinding,
  RuntimeExportRecord,
  RuntimeManifest,
  RuntimeResult,
  SchedulingDiagnostic,
  InputSlot,
  InputSource,
  TurnInput,
} from "@covel/shared";
import { getRuntimeSpec, hasIllegalDetachedContract } from "@covel/shared";
import { validateOutput } from "@covel/tools";

export { hasIllegalDetachedContract };
import {
  checkAcceptsCompatibility,
  projectSchemaBySelect,
  resolveJsonPointer,
} from "./accepts-compat.js";
import type { MediaCanonicalization } from "../media/canonicalize-media-refs.js";

type Schema = Readonly<Record<string, unknown>>;

/** Machine-readable skip reasons a binding gate can emit. */
export type BindingSkipReason =
  | "missing-provider"
  | "cardinality-conflict"
  | "upstream-failed"
  | "input-missing"
  | "input-schema-invalid"
  | "input-schema-incompatible"
  | "invalid-detached-contract"
  | "media-ownership-invalid";

export type BindingResolution =
  | {
      readonly ok: true;
      readonly slots: Readonly<Record<string, InputSlot>>;
      readonly diagnostics: readonly SchedulingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly skipReason: BindingSkipReason;
      readonly diagnostics: readonly SchedulingDiagnostic[];
    };

export interface ResolveBindingsInput {
  readonly manifest: RuntimeManifest;
  readonly activation: RuntimeActivation;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  /** Consumer's loaded `accepts` schemas, keyed by binding name. */
  readonly acceptsSchemas: Readonly<Record<string, Schema>>;
  /** Producer's declared `output.schema` (for the build-time compatibility check). */
  readonly loadProducerSchema: (
    producer: RuntimeManifest,
  ) => Promise<Schema | undefined>;
  /**
   * Canonicalize + ownership-check the MediaRefs in an about-to-be-injected
   * value (docs 02 §2.1). Injected before `accepts` runs, so `accepts` sees the
   * canonical value. Absent (test harnesses / no MediaStore) ⇒ values inject
   * unchanged — a media-free value is identical either way.
   */
  readonly canonicalizeValue?: (
    value: JsonValue,
  ) => Promise<MediaCanonicalization>;
}

/**
 * Canonicalize one binding value's MediaRefs, recording canonicalization
 * diagnostics and (on rejection) a single `media-ownership-invalid` diagnostic.
 * Shared by the `one` and `all` branches so both map rejections identically.
 */
async function canonicalizeBindingValue(
  canonicalize: (value: JsonValue) => Promise<MediaCanonicalization>,
  value: JsonValue,
  ctx: { runtimeId: string; bindingName: string; required: boolean },
  diagnostics: SchedulingDiagnostic[],
): Promise<{ value: JsonValue; rejected: boolean }> {
  const result = await canonicalize(value);
  for (const d of result.diagnostics) {
    diagnostics.push(
      diag(
        d.code,
        "warn",
        ctx.runtimeId,
        `binding "${ctx.bindingName}": ${d.message}`,
      ),
    );
  }
  if (result.rejections.length > 0) {
    diagnostics.push(
      diag(
        "media-ownership-invalid",
        ctx.required ? "error" : "warn",
        ctx.runtimeId,
        `binding "${ctx.bindingName}": ${result.rejections
          .map((r) => `${r.id}:${r.reason}`)
          .join("; ")}`,
      ),
    );
    return { value: result.value, rejected: true };
  }
  return { value: result.value, rejected: false };
}

/**
 * Derive this activation's `RuntimeActivation` from the run-time signals the
 * executor already threads. `event` wins over `manual` so a background follower
 * that replays an event (manual RPC carrying a `triggerEvent`) reads as an
 * event source, matching the canonical payload rule (02 §3.3).
 */
export function deriveActivation(
  manifest: RuntimeManifest,
  input: TurnInput,
  triggerEvent:
    | {
        readonly topic: string;
        readonly data: Readonly<Record<string, unknown>>;
      }
    | undefined,
): RuntimeActivation {
  const backgroundWhenDetached =
    getRuntimeSpec(manifest).backgroundWhenDetached;
  if (triggerEvent !== undefined) {
    return {
      source: "event",
      detached: backgroundWhenDetached,
      payload: (triggerEvent.data ?? null) as JsonValue,
    };
  }
  if (input.manualTrigger?.runtimeId === manifest.name) {
    return {
      source: "manual",
      detached: backgroundWhenDetached,
      payload: (input.manualTrigger.payload ?? null) as JsonValue,
    };
  }
  return { source: "stage", detached: false, payload: null };
}

function providersFor(
  binding: RuntimeBinding,
  activeRuntimes: readonly RuntimeManifest[],
): {
  readonly providers: readonly RuntimeManifest[];
  readonly cardinality: "one" | "all";
} {
  if ("runtime" in binding.from) {
    const runtimeName = binding.from.runtime;
    const p = activeRuntimes.find((r) => r.name === runtimeName);
    return { providers: p ? [p] : [], cardinality: "one" };
  }
  const cap = binding.from.capability;
  return {
    providers: activeRuntimes.filter((r) => r.capabilities?.includes(cap)),
    cardinality: binding.from.cardinality ?? "one",
  };
}

/** Extract a producer's selected success value + its provenance source. */
function extractValue(
  producer: RuntimeManifest,
  binding: RuntimeBinding,
  completedResults: ReadonlyMap<string, RuntimeResult>,
):
  | { ok: true; value: JsonValue; source: InputSource }
  | { ok: false; reason: "upstream-failed" | "input-missing" } {
  const result = completedResults.get(producer.name);
  if (!result || result.status !== "success") {
    return { ok: false, reason: "upstream-failed" };
  }
  let value: unknown = result.output;
  if (binding.select) {
    const resolved = resolveJsonPointer(value, binding.select);
    if (!resolved.found) return { ok: false, reason: "input-missing" };
    value = resolved.value;
  }
  return {
    ok: true,
    value: value as JsonValue,
    source: {
      pluginId: producer.pluginId,
      runtimeId: producer.name,
      resultId: result.runId,
    },
  };
}

function diag(
  code: string,
  severity: "warn" | "error",
  runtimeId: string,
  message: string,
): SchedulingDiagnostic {
  return { code, severity, runtimeId, message };
}

/**
 * Resolve every `inputs` binding for one activation into provenance-wrapped
 * slots, or a single skip reason (required-binding gate failure).
 */
export async function resolveInputBindings(
  args: ResolveBindingsInput,
): Promise<BindingResolution> {
  const { manifest, activation, activeRuntimes, completedResults } = args;
  const spec = getRuntimeSpec(manifest);
  const bindingEntries = Object.entries(spec.bindings);
  const diagnostics: SchedulingDiagnostic[] = [];

  // manual activation projects turn bindings away (01 §4): the target runs on
  // its activation payload, not the turn's visible set.
  if (activation.source === "manual") {
    return { ok: true, slots: {}, diagnostics };
  }
  if (bindingEntries.length === 0) {
    return { ok: true, slots: {}, diagnostics };
  }
  // A detached activation carrying turn bindings is rejected for this
  // activation (the spec stays valid for its non-detached activations).
  if (activation.detached) {
    return {
      ok: false,
      skipReason: "invalid-detached-contract",
      diagnostics: [
        diag(
          "invalid-detached-contract",
          "error",
          manifest.name,
          `detached activation cannot satisfy turn bindings: ${bindingEntries.map(([n]) => n).join(", ")}`,
        ),
      ],
    };
  }

  const slots: Record<string, InputSlot> = {};

  for (const [name, binding] of bindingEntries) {
    const required = binding.required !== false;
    const acceptsSchema = args.acceptsSchemas[name];
    const { providers, cardinality } = providersFor(binding, activeRuntimes);

    // cardinality: one with multiple providers is a build-time ambiguity.
    if (cardinality === "one" && providers.length > 1) {
      diagnostics.push(
        diag(
          "cardinality-conflict",
          "error",
          manifest.name,
          `binding "${name}" is cardinality:one but ${providers.length} providers matched`,
        ),
      );
      return { ok: false, skipReason: "cardinality-conflict", diagnostics };
    }

    if (providers.length === 0) {
      diagnostics.push(
        diag(
          "missing-provider",
          required ? "error" : "warn",
          manifest.name,
          `binding "${name}" has no active provider`,
        ),
      );
      if (required)
        return { ok: false, skipReason: "missing-provider", diagnostics };
      continue; // optional → omit slot
    }

    // Build-time accepts compatibility, per provider (docs 02 §3.1). Proven
    // incompatible → skip; indeterminate → diagnostic + always-on runtime check.
    if (acceptsSchema) {
      const itemsSchema =
        cardinality === "all" ? asSchema(acceptsSchema.items) : acceptsSchema;
      for (const provider of providers) {
        const producerSchema = await args.loadProducerSchema(provider);
        const projected = projectSchemaBySelect(producerSchema, binding.select);
        const compat = checkAcceptsCompatibility(
          projected,
          itemsSchema ?? acceptsSchema,
        );
        if (compat === "incompatible") {
          diagnostics.push(
            diag(
              "input-schema-incompatible",
              "error",
              manifest.name,
              `binding "${name}" producer "${provider.name}" is provably incompatible with accepts`,
            ),
          );
          return {
            ok: false,
            skipReason: "input-schema-incompatible",
            diagnostics,
          };
        }
        if (compat === "indeterminate") {
          diagnostics.push(
            diag(
              "slot-compatibility-indeterminate",
              "warn",
              manifest.name,
              `binding "${name}" producer "${provider.name}" compatibility undecidable — deferring to runtime check`,
            ),
          );
        }
      }
    }

    // Extract value(s).
    if (cardinality === "all") {
      const sorted = [...providers].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const items: { value: JsonValue; source: InputSource }[] = [];
      let failed: "upstream-failed" | "input-missing" | undefined;
      for (const provider of sorted) {
        const got = extractValue(provider, binding, completedResults);
        if (!got.ok) {
          failed = got.reason;
          break;
        }
        items.push({ value: got.value, source: got.source });
      }
      if (failed) {
        diagnostics.push(
          diag(
            failed,
            required ? "error" : "warn",
            manifest.name,
            `binding "${name}": ${failed}`,
          ),
        );
        if (required) return { ok: false, skipReason: failed, diagnostics };
        continue;
      }
      // Canonicalize each item's MediaRefs before the array accepts check.
      if (args.canonicalizeValue) {
        let rejected = false;
        for (let i = 0; i < items.length; i++) {
          const c = await canonicalizeBindingValue(
            args.canonicalizeValue,
            items[i]!.value,
            { runtimeId: manifest.name, bindingName: name, required },
            diagnostics,
          );
          if (c.rejected) {
            rejected = true;
            break;
          }
          items[i] = { value: c.value, source: items[i]!.source };
        }
        if (rejected) {
          if (required)
            return {
              ok: false,
              skipReason: "media-ownership-invalid",
              diagnostics,
            };
          continue;
        }
      }
      // Runtime full-schema check over the whole array (docs 02 §3.1).
      if (acceptsSchema) {
        const array = items.map((i) => i.value);
        const validation = validateOutput(array, acceptsSchema);
        if (!validation.valid) {
          diagnostics.push(
            diag(
              "input-schema-invalid",
              required ? "error" : "warn",
              manifest.name,
              `binding "${name}" array failed accepts: ${(validation.errors ?? []).slice(0, 3).join("; ")}`,
            ),
          );
          if (required)
            return {
              ok: false,
              skipReason: "input-schema-invalid",
              diagnostics,
            };
          continue;
        }
      }
      slots[name] = { cardinality: "all", items };
      continue;
    }

    const got = extractValue(providers[0]!, binding, completedResults);
    if (!got.ok) {
      diagnostics.push(
        diag(
          got.reason,
          required ? "error" : "warn",
          manifest.name,
          `binding "${name}": ${got.reason}`,
        ),
      );
      if (required) return { ok: false, skipReason: got.reason, diagnostics };
      continue;
    }
    let value = got.value;
    if (args.canonicalizeValue) {
      const c = await canonicalizeBindingValue(
        args.canonicalizeValue,
        value,
        { runtimeId: manifest.name, bindingName: name, required },
        diagnostics,
      );
      if (c.rejected) {
        if (required)
          return {
            ok: false,
            skipReason: "media-ownership-invalid",
            diagnostics,
          };
        continue;
      }
      value = c.value;
    }
    if (acceptsSchema) {
      const validation = validateOutput(value, acceptsSchema);
      if (!validation.valid) {
        diagnostics.push(
          diag(
            "input-schema-invalid",
            required ? "error" : "warn",
            manifest.name,
            `binding "${name}" failed accepts: ${(validation.errors ?? []).slice(0, 3).join("; ")}`,
          ),
        );
        if (required)
          return { ok: false, skipReason: "input-schema-invalid", diagnostics };
        continue;
      }
    }
    slots[name] = { cardinality: "one", value, source: got.source };
  }

  return { ok: true, slots, diagnostics };
}

function asSchema(value: unknown): Schema | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

// ── Persistent export consumption (docs 02 §3.4) ─────────────────

/** Machine-readable skip reasons an export-binding gate can emit. */
export type ExportBindingSkipReason =
  "export-missing" | "export-schema-invalid";

export type ExportBindingResolution =
  | {
      readonly ok: true;
      readonly slots: Readonly<Record<string, InputSlot>>;
      readonly diagnostics: readonly SchedulingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly skipReason: ExportBindingSkipReason;
      readonly diagnostics: readonly SchedulingDiagnostic[];
    };

export interface ResolveExportBindingsInput {
  readonly consumerRuntimeId: string;
  readonly exportBindings: Readonly<Record<string, RuntimeExportBinding>>;
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** Consumer's loaded export `accepts` schemas, keyed by binding name. */
  readonly acceptsSchemas: Readonly<Record<string, Schema>>;
  /**
   * Frozen read of a producer's latest committed export at execution start —
   * the caller pins `atOrBefore` to the execution's start instant so a revision
   * published mid-plan stays invisible to an already-running consumer.
   */
  readonly getFrozenExport: (
    producerRuntimeId: string,
    recordAs: string,
  ) => Promise<RuntimeExportRecord | null>;
}

/**
 * Resolve every `input.inject` `kind: runtime-export` binding into
 * provenance-wrapped slots, or a single gate skip. Unlike `inputs` bindings
 * (same-execution, in-memory), exports are cross-execution: the provider must be
 * in the active set and must have a committed revision frozen at execution
 * start, else a required binding skips the consumer (docs 02 §3.4.4). Runs for
 * every activation source — exports are not turn bindings, so manual / detached
 * activations still see them.
 */
export async function resolveExportBindings(
  args: ResolveExportBindingsInput,
): Promise<ExportBindingResolution> {
  const { exportBindings, activeRuntimes, acceptsSchemas, getFrozenExport } =
    args;
  const consumerRuntimeId = args.consumerRuntimeId;
  const entries = Object.entries(exportBindings);
  const diagnostics: SchedulingDiagnostic[] = [];
  if (entries.length === 0) return { ok: true, slots: {}, diagnostics };

  const slots: Record<string, InputSlot> = {};

  for (const [name, eb] of entries) {
    const required = eb.required !== false;
    const acceptsSchema = acceptsSchemas[name];
    const { providers, cardinality } = providersFor(
      { from: eb.from } as RuntimeBinding,
      activeRuntimes,
    );

    const gateMissing = (msg: string): ExportBindingResolution | undefined => {
      diagnostics.push(
        diag(
          "export-missing",
          required ? "error" : "warn",
          consumerRuntimeId,
          `export "${name}": ${msg}`,
        ),
      );
      return required
        ? { ok: false, skipReason: "export-missing", diagnostics }
        : undefined;
    };

    if (providers.length === 0) {
      const skip = gateMissing("provider not in active set");
      if (skip) return skip;
      continue;
    }
    if (cardinality === "one" && providers.length > 1) {
      const skip = gateMissing(
        `cardinality:one but ${providers.length} providers matched`,
      );
      if (skip) return skip;
      continue;
    }

    const targets =
      cardinality === "all"
        ? [...providers].sort((a, b) => a.name.localeCompare(b.name))
        : [providers[0]!];

    const items: { value: JsonValue; source: InputSource }[] = [];
    let skipReason: ExportBindingSkipReason | undefined;
    for (const provider of targets) {
      const record = await getFrozenExport(provider.name, eb.recordAs);
      if (!record) {
        skipReason = "export-missing";
        break;
      }
      // Runtime actual-value check against the consumer's `accepts` (docs 02
      // §3.1 / §3.4.4): a producer whose export shape the consumer cannot accept
      // (an incompatible schema digest manifests here) fails this validation.
      if (acceptsSchema) {
        const validation = validateOutput(record.value, acceptsSchema);
        if (!validation.valid) {
          diagnostics.push(
            diag(
              "export-schema-invalid",
              required ? "error" : "warn",
              consumerRuntimeId,
              `export "${name}" failed accepts: ${(validation.errors ?? [])
                .slice(0, 3)
                .join("; ")}`,
            ),
          );
          skipReason = "export-schema-invalid";
          break;
        }
      }
      items.push({
        value: record.value,
        source: {
          pluginId: record.producerPluginId,
          runtimeId: record.producerRuntimeId,
          resultId: record.resultId,
        },
      });
    }

    if (skipReason) {
      if (skipReason === "export-missing") {
        diagnostics.push(
          diag(
            "export-missing",
            required ? "error" : "warn",
            consumerRuntimeId,
            `export "${name}" has no committed revision`,
          ),
        );
      }
      if (required) return { ok: false, skipReason, diagnostics };
      continue; // optional → omit slot
    }

    slots[name] =
      cardinality === "all"
        ? { cardinality: "all", items }
        : {
            cardinality: "one",
            value: items[0]!.value,
            source: items[0]!.source,
          };
  }

  return { ok: true, slots, diagnostics };
}
