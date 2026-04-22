/**
 * Character fields ↔ CharacterAttributeSchema validator.
 *
 * `create-character` / `update-character` expose `fields: Record<string,
 * unknown>` to the LLM — intentionally permissive so storytelling isn't
 * blocked by an incomplete schema. This validator runs *after* the write
 * and surfaces a soft warning list into `_text` so the LLM can self-correct
 * on the next turn without us ever rejecting its call.
 *
 * Scope:
 *   - unknown-key detection (id not declared in schema)
 *   - type mismatch against the attribute's declared type
 *   - enum option violations
 *   - number out-of-range (min/max)
 *   - shape mismatch for `object` (needs nested record) and `map` (needs
 *     free-key record)
 *
 * Kept deliberately out of Zod so we get human-readable English/Chinese
 * warnings instead of Zod's machine-formatted issue paths, which tend to
 * confuse weaker models.
 */

import type {
  AttributeDefinition,
  AttributeFieldType,
  CharacterAttributeSchema,
} from '@covel/shared';

// ── Public surface ──────────────────────────────────────────────

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  /** Keys the LLM wrote that aren't declared in the schema. */
  readonly unknownKeys: readonly string[];
  /** Keys whose values don't fit the declared attribute type. */
  readonly typeMismatches: readonly SchemaValidationIssue[];
  /** Composite human-readable summary for inclusion in a tool _text. Empty when clean. */
  readonly warningText: string;
}

/**
 * Validate `fields` against a (potentially partial) CharacterAttributeSchema.
 * Always returns — never throws. Call sites decide what to do with the
 * warning text.
 */
export function validateFieldsAgainstSchema(
  fields: unknown,
  schema: CharacterAttributeSchema | null | undefined,
): SchemaValidationResult {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { unknownKeys: [], typeMismatches: [], warningText: '' };
  }
  if (!schema || !Array.isArray(schema.attributes) || schema.attributes.length === 0) {
    // Nothing to validate against — stay silent rather than over-warn.
    return { unknownKeys: [], typeMismatches: [], warningText: '' };
  }

  const attrById = new Map<string, AttributeDefinition>();
  for (const a of schema.attributes) attrById.set(a.id, a);

  const unknownKeys: string[] = [];
  const typeMismatches: SchemaValidationIssue[] = [];

  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const def = attrById.get(key);
    if (!def) {
      unknownKeys.push(key);
      continue;
    }
    const issues = checkAttribute(def, value, key);
    typeMismatches.push(...issues);
  }

  const warningText = formatWarnings(unknownKeys, typeMismatches, schema.attributes);

  return { unknownKeys, typeMismatches, warningText };
}

// ── Per-attribute type check ────────────────────────────────────

function checkAttribute(
  def: AttributeDefinition,
  value: unknown,
  path: string,
): SchemaValidationIssue[] {
  if (value === null || value === undefined) return [];

  switch (def.type as AttributeFieldType) {
    case 'string':
      return typeof value === 'string'
        ? []
        : [{ path, message: `expected string, got ${describe(value)}` }];

    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return [{ path, message: `expected number, got ${describe(value)}` }];
      }
      const issues: SchemaValidationIssue[] = [];
      if (def.min !== undefined && value < def.min) {
        issues.push({ path, message: `value ${value} below min ${def.min}` });
      }
      if (def.max !== undefined && value > def.max) {
        issues.push({ path, message: `value ${value} above max ${def.max}` });
      }
      return issues;
    }

    case 'boolean':
      return typeof value === 'boolean'
        ? []
        : [{ path, message: `expected boolean, got ${describe(value)}` }];

    case 'enum': {
      if (typeof value !== 'string') {
        return [{ path, message: `expected enum string, got ${describe(value)}` }];
      }
      const options = def.options ?? [];
      if (options.length > 0 && !options.includes(value)) {
        return [{
          path,
          message: `"${value}" not in enum options [${options.join(', ')}]`,
        }];
      }
      return [];
    }

    case 'array': {
      if (!Array.isArray(value)) {
        return [{ path, message: `expected array, got ${describe(value)}` }];
      }
      if (!def.itemType) return [];
      const bad = value.findIndex((v) => typeof v !== def.itemType);
      return bad >= 0
        ? [{
          path: `${path}[${bad}]`,
          message: `expected ${def.itemType}, got ${describe(value[bad])}`,
        }]
        : [];
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [{ path, message: `expected object, got ${describe(value)}` }];
      }
      // Recurse into subSchema if declared — each declared child gets
      // validated; unknown children on an object ARE currently tolerated
      // (they fall through as extra keys, same as top-level behaviour).
      if (!def.subSchema || def.subSchema.length === 0) return [];
      const issues: SchemaValidationIssue[] = [];
      const childById = new Map<string, AttributeDefinition>();
      for (const c of def.subSchema) childById.set(c.id, c);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const childDef = childById.get(k);
        if (!childDef) continue; // tolerate extras inside object
        issues.push(...checkAttribute(childDef, v, `${path}.${k}`));
      }
      return issues;
    }

    case 'map': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [{ path, message: `expected map (plain object), got ${describe(value)}` }];
      }
      const valueType = def.valueType ?? 'string';
      const issues: SchemaValidationIssue[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v !== valueType) {
          issues.push({
            path: `${path}.${k}`,
            message: `expected map value of ${valueType}, got ${describe(v)}`,
          });
        }
      }
      return issues;
    }

    default:
      return [];
  }
}

// ── Formatting ──────────────────────────────────────────────────

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatWarnings(
  unknownKeys: readonly string[],
  typeMismatches: readonly SchemaValidationIssue[],
  attributes: readonly AttributeDefinition[],
): string {
  if (unknownKeys.length === 0 && typeMismatches.length === 0) return '';

  const lines: string[] = [];
  if (unknownKeys.length > 0) {
    const knownIds = attributes.map((a) => a.id).join(', ');
    lines.push(
      `⚠ schema warning: unknown keys ${JSON.stringify(unknownKeys)} — ` +
      `declared attribute ids are [${knownIds}]. ` +
      `The values were saved but won't appear in the schema-aware UI. ` +
      `Either fold them into an existing id, or add a new attribute via set-world-schema.`,
    );
  }
  if (typeMismatches.length > 0) {
    const summary = typeMismatches
      .slice(0, 5)
      .map((i) => `  - ${i.path}: ${i.message}`)
      .join('\n');
    const more = typeMismatches.length > 5 ? `\n  … and ${typeMismatches.length - 5} more` : '';
    lines.push(`⚠ schema warning: type/range issues:\n${summary}${more}`);
  }
  return lines.join('\n');
}
