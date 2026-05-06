import { characterBlueprintToCharacterUpsert } from "@covel/shared";
import { withPendingProposals } from "@covel/tools";

const BLUEPRINT_NAMESPACE = "blueprints";
const DEFAULT_MIRROR_PLUGIN_ID = "character-blueprint";
const MAX_BLUEPRINT_BYTES = 65_536;
const BLUEPRINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
	const payload = ctx.manualPayload ?? {};
	const blueprint = normalizeBlueprint(readBlueprintPayload(payload));
	const shouldInstantiate =
		payload.instantiate === true || blueprint.instantiate !== undefined;
	const now = new Date().toISOString();
	const proposals = [
		makeProposal(ctx, now, "plugin.data", {
			namespace: BLUEPRINT_NAMESPACE,
			key: blueprint.id,
			value: {
				blueprint,
				importedAt: now,
				...(shouldInstantiate
					? { instantiatedCharacterId: characterIdForBlueprint(blueprint) }
					: {}),
			},
		}),
	];

	let characterId;
	if (shouldInstantiate) {
		const upsert = characterBlueprintToCharacterUpsert(blueprint, {
			now,
			mirrorPluginId: DEFAULT_MIRROR_PLUGIN_ID,
		});
		characterId = upsert.id;
		proposals.push(makeProposal(ctx, now, "character.upsert", upsert));
	}

	return withPendingProposals(
		{
			imported: true,
			blueprintId: blueprint.id,
			instantiated: shouldInstantiate,
			...(characterId ? { characterId } : {}),
		},
		proposals,
	);
}

function readBlueprintPayload(payload) {
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		if (typeof payload.blueprintJson === "string") {
			try {
				return JSON.parse(payload.blueprintJson);
			} catch {
				throw new Error("manualPayload.blueprintJson must be valid JSON");
			}
		}
		return payload.blueprint;
	}
	return undefined;
}

/**
 * @param {unknown} value
 */
function normalizeBlueprint(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("manualPayload.blueprint must be an object");
	}

	const input = /** @type {Record<string, unknown>} */ (value);
	const id = normalizeRequiredString(input.id, "blueprint.id");
	const name = normalizeRequiredString(input.name, "blueprint.name");
	if (!BLUEPRINT_ID_PATTERN.test(id)) {
		throw new Error(
			"blueprint.id must be 1-128 characters using letters, digits, underscore, or hyphen",
		);
	}
	const schemaVersion = input.schemaVersion ?? 1;
	if (schemaVersion !== 1) {
		throw new Error("blueprint.schemaVersion must be 1");
	}

	const blueprint = {
		...input,
		schemaVersion: 1,
		id,
		name,
	};
	const serialized = JSON.stringify(blueprint);
	if (serialized.length > MAX_BLUEPRINT_BYTES) {
		throw new Error("blueprint is too large; max serialized size is 64KB");
	}
	return blueprint;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function normalizeRequiredString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

/**
 * @param {Record<string, unknown>} blueprint
 */
function characterIdForBlueprint(blueprint) {
	const instantiate = blueprint.instantiate;
	if (
		instantiate &&
		typeof instantiate === "object" &&
		!Array.isArray(instantiate)
	) {
		const characterId = /** @type {Record<string, unknown>} */ (instantiate)
			.characterId;
		if (typeof characterId === "string" && characterId.length > 0) {
			return characterId;
		}
	}
	return `char-${blueprint.id}`;
}

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @param {string} now
 * @param {import('@covel/shared').ProposalType} type
 * @param {Record<string, unknown>} payload
 */
function makeProposal(ctx, now, type, payload) {
	return {
		id: crypto.randomUUID(),
		type,
		source: {
			pluginId: ctx.pluginId,
			runtimeId: ctx.runtimeId ?? ctx.pluginId,
		},
		turnId: ctx.turnId,
		sessionId: ctx.sessionId,
		payload,
		timestamp: now,
	};
}
