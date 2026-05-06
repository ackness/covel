/**
 * CharacterAttributeSchema → Zod converter.
 *
 * Phase 2 lets the LLM see named character `fields` directly in the tool
 * parameter schema instead of the generic `Record<string, unknown>`. The
 * conversion is performed on the server at turn start (once per session,
 * cached) so the LLM receives a JSON schema that precisely describes the
 * active world's attributes — including numeric ranges, enum options,
 * and structured object/map shapes.
 *
 * The result is always **permissive** (`.catchall(z.unknown())` on objects
 * and any `z.record`) so storytelling isn't blocked when the LLM tries to
 * set a field the schema hasn't declared yet. Off-schema keys still trigger
 * the soft `_text` warning produced by `schema-validator`.
 */

import { z, type ZodType } from "zod";
import type {
	AttributeDefinition,
	CharacterAttributeSchema,
} from "@covel/shared";

/**
 * Build a Zod schema for `CharacterRecord.fields` from a session's
 * `CharacterAttributeSchema`. Each declared attribute becomes an explicitly
 * typed, optional field; unknown keys are accepted via `.catchall`.
 *
 * Returns `null` when the schema is empty — callers should keep their
 * fallback `z.record(z.string(), z.unknown())` path for that case.
 */
export function buildFieldsZodFromSchema(
	schema: CharacterAttributeSchema,
): ZodType | null {
	if (!schema?.attributes?.length) return null;

	const shape: Record<string, ZodType> = {};
	for (const attr of schema.attributes) {
		shape[attr.id] = attributeToZod(attr)
			.optional()
			.describe(attrDescribe(attr));
	}

	return z.object(shape).catchall(z.unknown());
}

// ── Internals ───────────────────────────────────────────────────

function attributeToZod(attr: AttributeDefinition): ZodType {
	switch (attr.type) {
		case "string":
			return z.string();

		case "number": {
			// Zod 4 keeps the fluent `.min()/.max()` on ZodNumber.
			let schema = z.number();
			if (typeof attr.min === "number") schema = schema.min(attr.min);
			if (typeof attr.max === "number") schema = schema.max(attr.max);
			return schema;
		}

		case "boolean":
			return z.boolean();

		case "enum": {
			// Zod requires a non-empty tuple for `z.enum`. Degenerate schemas
			// (empty `options`) fall back to free-form string so the LLM isn't
			// blocked by a malformed world schema.
			const options = attr.options ?? [];
			if (options.length === 0) return z.string();
			return z.enum(options as [string, ...string[]]);
		}

		case "array": {
			const item = attr.itemType === "number" ? z.number() : z.string();
			return z.array(item);
		}

		case "object": {
			// `object` without `subSchema` degenerates to a permissive record.
			if (!attr.subSchema?.length) {
				return z.record(z.string(), z.unknown());
			}
			const innerShape: Record<string, ZodType> = {};
			for (const sub of attr.subSchema) {
				innerShape[sub.id] = attributeToZod(sub)
					.optional()
					.describe(attrDescribe(sub));
			}
			return z.object(innerShape).catchall(z.unknown());
		}

		case "map": {
			const vt = attr.valueType ?? "string";
			const valueSchema =
				vt === "number"
					? z.number()
					: vt === "boolean"
						? z.boolean()
						: z.string();
			return z.record(z.string(), valueSchema);
		}

		default:
			return z.unknown();
	}
}

/**
 * Build a human-readable description per attribute — combines `name` with
 * any category / constraint hints so the LLM sees both the label and the
 * structural expectation in the field description. Kept short: the attribute
 * description itself is the primary source for longer prose.
 */
function attrDescribe(attr: AttributeDefinition): string {
	const parts: string[] = [attr.name];

	switch (attr.type) {
		case "number": {
			const bounds: string[] = [];
			if (attr.min !== undefined) bounds.push(`min=${attr.min}`);
			if (attr.max !== undefined) bounds.push(`max=${attr.max}`);
			if (bounds.length > 0) parts.push(`(${bounds.join(", ")})`);
			break;
		}
		case "enum":
			if (attr.options?.length) parts.push(`∈ [${attr.options.join(" | ")}]`);
			break;
		case "array":
			parts.push(`(array of ${attr.itemType ?? "string"})`);
			break;
		case "map":
			parts.push(`(map → ${attr.valueType ?? "string"})`);
			break;
	}

	if (attr.description) parts.push(`— ${attr.description}`);
	return parts.join(" ");
}
