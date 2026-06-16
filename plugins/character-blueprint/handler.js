import {
  compactRecord,
  makeProposal,
  normalizeRequiredString,
  optionalString,
  splitList,
} from "@covel/plugin-handlers-utils";
import { characterBlueprintToCharacterUpsert } from "@covel/shared";
import { shortId, withPendingProposals } from "@covel/tools";

const BLUEPRINT_NAMESPACE = "blueprints";
const DEFAULT_MIRROR_PLUGIN_ID = "character-blueprint";
const CHARACTER_PANEL_PLUGIN_ID = "char-creator";
const MAX_BLUEPRINT_BYTES = 65_536;
const BLUEPRINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_SCOPED_CHARACTER_ID_LENGTH = 180;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const isFormPayload =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.blueprintForm &&
    typeof payload.blueprintForm === "object";
  const blueprint = normalizeBlueprint(
    readBlueprintPayload(payload, ctx.sessionId),
  );
  const shouldInstantiate =
    typeof payload.instantiate === "boolean"
      ? payload.instantiate
      : !isFormPayload && blueprint.instantiate !== undefined;
  const now = new Date().toISOString();
  const proposals = [
    makeProposal(ctx, now, "plugin.data", {
      namespace: BLUEPRINT_NAMESPACE,
      key: blueprint.id,
      value: {
        blueprint,
        importedAt: now,
        ...(shouldInstantiate
          ? {
              instantiatedCharacterId: scopedCharacterIdForBlueprint(
                ctx.sessionId,
                blueprint,
              ),
            }
          : {}),
      },
    }),
  ];

  let characterId;
  if (shouldInstantiate) {
    characterId = scopedCharacterIdForBlueprint(ctx.sessionId, blueprint);
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      characterId,
      now,
      mirrorPluginId: DEFAULT_MIRROR_PLUGIN_ID,
    });
    proposals.push(
      makeProposal(ctx, now, "character.upsert", {
        ...upsert,
        mirrorPluginIds: [CHARACTER_PANEL_PLUGIN_ID],
      }),
    );
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

function readBlueprintPayload(payload, sessionId) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (
      typeof payload.blueprintJson === "string" &&
      payload.blueprintJson.trim().length > 0
    ) {
      try {
        return JSON.parse(payload.blueprintJson);
      } catch {
        throw new Error("manualPayload.blueprintJson must be valid JSON");
      }
    }
    if (payload.blueprintForm && typeof payload.blueprintForm === "object") {
      return blueprintFromForm(
        /** @type {Record<string, unknown>} */ (payload.blueprintForm),
        payload.instantiate === true,
        sessionId,
      );
    }
    return payload.blueprint;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} form
 * @param {boolean} includeInstantiate
 * @param {string} sessionId
 */
function blueprintFromForm(form, includeInstantiate, sessionId) {
  const name = normalizeRequiredString(form.name, "blueprint.name");
  const explicitId = optionalString(form.id);
  const id = explicitId ?? shortId(rolePrefix(form.role), name, sessionId);
  const role =
    typeof form.role === "string" && form.role.trim().length > 0
      ? form.role.trim()
      : "npc";
  const aliases = splitList(form.aliasesText);
  const tags = splitList(form.tagsText);
  const traits = splitList(form.traitsText);
  const goals = splitList(form.goalsText);
  const persona = compactRecord(
    {
      summary: optionalString(form.personaSummary),
      traits,
      goals,
      voice: optionalString(form.voice),
      style: optionalString(form.style),
    },
    { dropEmptyArrays: true },
  );
  const attributes = compactRecord({
    club: optionalString(form.club),
    class: optionalString(form.className),
    relationshipStage: optionalString(form.relationshipStage),
  });

  return {
    schemaVersion: 1,
    id,
    name,
    role,
    ...(optionalString(form.description)
      ? { description: optionalString(form.description) }
      : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(persona).length > 0 ? { persona } : {}),
    ...(includeInstantiate
      ? {
          instantiate: {
            characterId:
              optionalString(form.characterId) ??
              (explicitId
                ? `${rolePrefix(role)}-${id.replace(/_/g, "-").toLowerCase()}`
                : id),
            type: role,
          },
        }
      : {}),
  };
}

function rolePrefix(value) {
  return value === "player" ? "player" : "npc";
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
 * @param {string} sessionId
 * @param {Record<string, unknown>} blueprint
 */
function scopedCharacterIdForBlueprint(sessionId, blueprint) {
  const instantiate = blueprint.instantiate;
  let baseId = `char-${blueprint.id}`;
  if (
    instantiate &&
    typeof instantiate === "object" &&
    !Array.isArray(instantiate)
  ) {
    const characterId = /** @type {Record<string, unknown>} */ (instantiate)
      .characterId;
    if (typeof characterId === "string" && characterId.length > 0) {
      baseId = characterId;
    }
  }
  const scopedId = `${sessionId}-${baseId}`;
  return scopedId.length <= MAX_SCOPED_CHARACTER_ID_LENGTH
    ? scopedId
    : `${sessionId}-${blueprint.id}`;
}
