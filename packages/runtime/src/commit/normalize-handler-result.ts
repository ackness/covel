/**
 * Unified handler-result normalization (docs 02 §4).
 *
 * One funnel every runtime entry can call to turn a raw handler return into a
 * discriminated `HandlerResult` plus diagnostics. It does NOT commit anything
 * and does NOT read the store — pure classification, so agent paths can call it
 * observe-only (compare against their own result, record divergence) while the
 * function path uses its classification to set `RuntimeResult.status`.
 *
 * Two formats (docs 02 §4.3):
 *  - `legacy` (default): the whole object is preserved as `value`; known control
 *    keys are copied to `effects` for observability (the commit path still
 *    re-derives proposals from `value`, so this copy is informational); a
 *    business `status: "failed" | "skipped" | "suspended"` maps to the matching
 *    outcome, everything else is `success`.
 *  - `envelope-v1`: the explicit `{ outcome, value, effects, ... }` union is
 *    parsed; a malformed shape becomes `failed: output-schema-invalid`; a
 *    success `value` is checked against the JSON wire boundary.
 *
 * Non-success isolation (docs 02 §4.1): a `skipped` / `failed` envelope may only
 * carry observability effects (`jobStatus` / `diagnostics`); any domain write is
 * stripped with a `non-success-domain-effects-stripped` diagnostic.
 */

import { isJsonValue } from "@covel/shared";
import type {
  HandlerResult,
  JsonSchema,
  JsonValue,
  ObservabilityEffects,
  RuntimeDiagnostic,
  RuntimeEffects,
  RuntimeResultFormat,
} from "@covel/shared";

export interface NormalizeHandlerResultSpec {
  readonly resultFormat: RuntimeResultFormat;
  readonly runtimeType: "agent" | "function";
}

export interface NormalizedHandlerResult {
  readonly outcome: HandlerResult;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/** Domain-effect control keys the runtime output normalizer understands. */
export const DOMAIN_EFFECT_KEYS = [
  "statePatches",
  "events",
  "interactions",
  "ui",
  "assetGenerations",
  "pluginData",
  "notifications",
] as const;

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonSchema(value: unknown): JsonSchema | undefined {
  return isPlainObject(value) ? (value as JsonSchema) : undefined;
}

/** Copy present observability channels out of an effects-like object. */
function pickObservability(
  effects: Record<string, unknown> | undefined,
): ObservabilityEffects {
  const out: { -readonly [K in keyof ObservabilityEffects]: unknown } = {};
  if (effects && Array.isArray(effects.jobStatus)) {
    out.jobStatus = effects.jobStatus as ObservabilityEffects["jobStatus"];
  }
  if (effects && Array.isArray(effects.diagnostics)) {
    out.diagnostics =
      effects.diagnostics as ObservabilityEffects["diagnostics"];
  }
  return out as ObservabilityEffects;
}

function hasKeys(obj: object): boolean {
  return Object.keys(obj).length > 0;
}

/** True when an effects-like object carries any domain write. */
function hasDomainEffects(
  effects: Record<string, unknown> | undefined,
): boolean {
  if (!effects) return false;
  return DOMAIN_EFFECT_KEYS.some(
    (k) => effects[k] !== undefined && effects[k] !== null,
  );
}

/**
 * Reduce a non-success envelope's effects to observability-only, recording a
 * diagnostic when domain writes were present and dropped.
 */
function stripNonSuccessEffects(
  effects: Record<string, unknown> | undefined,
  diagnostics: RuntimeDiagnostic[],
): ObservabilityEffects | undefined {
  if (hasDomainEffects(effects)) {
    diagnostics.push({
      code: "non-success-domain-effects-stripped",
      message:
        "domain effects on a non-success outcome were stripped (only jobStatus / diagnostics are allowed)",
    });
  }
  const obs = pickObservability(effects);
  return hasKeys(obs) ? obs : undefined;
}

/** Copy the known legacy control keys into a success `effects` bag. */
function collectLegacyEffects(
  obj: Record<string, unknown>,
): RuntimeEffects | undefined {
  const out: Record<string, unknown> = {};
  for (const key of DOMAIN_EFFECT_KEYS) {
    const v = obj[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  const obs = pickObservability(obj);
  Object.assign(out, obs);
  return hasKeys(out) ? (out as RuntimeEffects) : undefined;
}

function normalizeLegacy(raw: unknown): NormalizedHandlerResult {
  const diagnostics: RuntimeDiagnostic[] = [];

  // A non-object legacy return is preserved verbatim as a success value.
  if (!isPlainObject(raw)) {
    return {
      outcome: { outcome: "success", value: raw as JsonValue },
      diagnostics,
    };
  }

  const status = typeof raw.status === "string" ? raw.status : undefined;

  if (status === "suspended" && typeof raw.reason === "string") {
    const schema = asJsonSchema(raw.resumeSchema);
    return {
      outcome: {
        outcome: "suspended",
        reason: raw.reason,
        ...(schema ? { resumeSchema: schema } : {}),
      },
      diagnostics,
    };
  }

  if (status === "failed") {
    const effects = stripNonSuccessEffects(raw, diagnostics);
    return {
      outcome: {
        outcome: "failed",
        error:
          typeof raw.error === "string"
            ? raw.error
            : "handler reported failure",
        ...(effects ? { effects } : {}),
      },
      diagnostics,
    };
  }

  if (status === "skipped") {
    const effects = stripNonSuccessEffects(raw, diagnostics);
    return {
      outcome: {
        outcome: "skipped",
        skipReason:
          typeof raw.reason === "string" ? raw.reason : "handler reported skip",
        ...(effects ? { effects } : {}),
      },
      diagnostics,
    };
  }

  // Success (including `status: "done"` and any other / absent status): the
  // whole object is preserved as `value` so downstream binding reads and the
  // commit-path normalizer see every field; control keys are copied to effects
  // for observability only.
  const effects = collectLegacyEffects(raw);
  return {
    outcome: {
      outcome: "success",
      value: raw as JsonValue,
      ...(effects ? { effects } : {}),
    },
    diagnostics,
  };
}

function normalizeEnvelopeV1(raw: unknown): NormalizedHandlerResult {
  const diagnostics: RuntimeDiagnostic[] = [];

  const invalid = (message: string): NormalizedHandlerResult => ({
    outcome: { outcome: "failed", error: `output-schema-invalid: ${message}` },
    diagnostics,
  });

  if (!isPlainObject(raw)) {
    return invalid("envelope-v1 return is not an object");
  }

  const effects = isPlainObject(raw.effects) ? raw.effects : undefined;

  switch (raw.outcome) {
    case "success": {
      if (raw.value !== undefined && !isJsonValue(raw.value)) {
        diagnostics.push({
          code: "value-not-json-serialisable",
          message: "envelope-v1 value is not a JSON wire value",
        });
        return invalid("value is not JSON-serialisable");
      }
      const obs = pickObservability(effects);
      const merged: Record<string, unknown> = {};
      // A success envelope keeps every declared effect (domain + observability).
      if (effects) Object.assign(merged, effects);
      Object.assign(merged, obs);
      return {
        outcome: {
          outcome: "success",
          ...(raw.value !== undefined ? { value: raw.value as JsonValue } : {}),
          ...(hasKeys(merged) ? { effects: merged as RuntimeEffects } : {}),
          ...(raw.completion === "done" || raw.completion === "pending"
            ? { completion: raw.completion }
            : {}),
        },
        diagnostics,
      };
    }
    case "suspended": {
      if (typeof raw.reason !== "string") {
        return invalid("suspended outcome requires a string reason");
      }
      const schema = asJsonSchema(raw.resumeSchema);
      return {
        outcome: {
          outcome: "suspended",
          reason: raw.reason,
          ...(schema ? { resumeSchema: schema } : {}),
        },
        diagnostics,
      };
    }
    case "skipped": {
      const obs = stripNonSuccessEffects(effects, diagnostics);
      return {
        outcome: {
          outcome: "skipped",
          skipReason:
            typeof raw.skipReason === "string" ? raw.skipReason : "skipped",
          ...(obs ? { effects: obs } : {}),
        },
        diagnostics,
      };
    }
    case "failed": {
      const obs = stripNonSuccessEffects(effects, diagnostics);
      return {
        outcome: {
          outcome: "failed",
          error:
            typeof raw.error === "string"
              ? raw.error
              : "handler reported failure",
          ...(obs ? { effects: obs } : {}),
        },
        diagnostics,
      };
    }
    default:
      return invalid(`unknown outcome "${String(raw.outcome)}"`);
  }
}

/**
 * Classify a raw handler return into a `HandlerResult` + diagnostics. Pure:
 * no store access, no commits — safe to call observe-only.
 */
export function normalizeHandlerResult(
  raw: unknown,
  spec: NormalizeHandlerResultSpec,
): NormalizedHandlerResult {
  return spec.resultFormat === "envelope-v1"
    ? normalizeEnvelopeV1(raw)
    : normalizeLegacy(raw);
}
