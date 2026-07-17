/**
 * UI spec validation — Zod schema + structured diagnostics for /api/ui-specs.
 *
 * A "UI spec" is the JSON object a plugin ships under `ui/*.json` (or a
 * `{ _componentPath }` stub the loader emits for `.tsx`/`.js` custom
 * components). Specs are *untrusted plugin input*, so the aggregation endpoint
 * validates every spec before exposing it to the frontend. A single malformed
 * spec must never poison the whole response — it is skipped from the rendered
 * slots and reported via `diagnostics` so the offending plugin/field/problem
 * is named instead of degrading to a generic "Invalid panel spec".
 */

import { z } from "zod";
import type { UiSlotName } from "./shared.js";

/**
 * Current UI spec schema version understood by the server. Specs MAY omit
 * `specVersion` — legacy specs (all currently bundled ones) are treated as v1.
 * A spec declaring a HIGHER version than this fails validation with an
 * explicit diagnostic, so a newer plugin pack on an older server degrades
 * loudly instead of silently rendering a broken panel.
 */
const CURRENT_UI_SPEC_VERSION = 1;

const i18nTextSchema = z.union([z.string(), z.record(z.string(), z.string())]);

/**
 * Validates the structural envelope of a UI spec. Unknown keys are ignored
 * (forward compatibility) — callers pass the ORIGINAL spec through to the
 * frontend untouched, so Zod's stripping never mutates what ships.
 */
const uiSpecSchema = z
  .object({
    specVersion: z
      .number()
      .int()
      .min(1, { message: "specVersion must be >= 1" })
      .max(CURRENT_UI_SPEC_VERSION, {
        message: `unsupported specVersion (server supports up to ${CURRENT_UI_SPEC_VERSION})`,
      })
      .optional(),
    id: z
      .string()
      .min(1, { message: "id must be a non-empty string" })
      .optional(),
    label: i18nTextSchema.optional(),
    shortLabel: i18nTextSchema.optional(),
    icon: z.string().optional(),
    group: z.string().optional(),
    groupLabel: i18nTextSchema.optional(),
    groupOrder: z.number().optional(),
    dataSource: z
      .object({
        namespace: z.string().optional(),
        source: z.string().optional(),
      })
      .optional(),
    emptyState: z.object({ message: i18nTextSchema.optional() }).optional(),
    alwaysRender: z.boolean().optional(),
    view: z.record(z.string(), z.unknown()).optional(),
    _componentPath: z.string().min(1).optional(),
  })
  .superRefine((spec, ctx) => {
    const hasView = spec.view !== undefined && spec.view !== null;
    const hasComponentPath = typeof spec._componentPath === "string";
    if (!hasView && !hasComponentPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["view"],
        message:
          "spec must declare a `view` object (json-render) or a `_componentPath` (custom component)",
      });
    }
  });

export interface UiSpecIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export interface UiSpecDiagnostic {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly slot: UiSlotName;
  readonly specIndex: number;
  readonly specId?: string;
  readonly issues: readonly UiSpecIssue[];
}

/** Pull a spec's declared `id` for diagnostic labelling, if any. */
function uiSpecId(spec: unknown): string | undefined {
  if (spec && typeof spec === "object") {
    const id = (spec as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** Validate one spec, returning concrete per-field issues on failure. */
function validateUiSpec(
  spec: unknown,
): { ok: true } | { ok: false; issues: UiSpecIssue[] } {
  const result = uiSpecSchema.safeParse(spec);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
      code: String(issue.code),
    })),
  };
}

/**
 * Validate every spec in one slot. Returns only the valid specs (order
 * preserved) plus a diagnostic per rejected spec. The original spec objects
 * are returned by reference — never cloned or mutated.
 */
export function partitionSlotSpecs(args: {
  specs: readonly Record<string, unknown>[];
  pluginId: string;
  runtimeId: string;
  slot: UiSlotName;
}): {
  valid: Record<string, unknown>[];
  diagnostics: UiSpecDiagnostic[];
} {
  const valid: Record<string, unknown>[] = [];
  const diagnostics: UiSpecDiagnostic[] = [];
  args.specs.forEach((spec, specIndex) => {
    const res = validateUiSpec(spec);
    if (res.ok) {
      valid.push(spec);
      return;
    }
    diagnostics.push({
      pluginId: args.pluginId,
      runtimeId: args.runtimeId,
      slot: args.slot,
      specIndex,
      specId: uiSpecId(spec),
      issues: res.issues,
    });
  });
  return { valid, diagnostics };
}
