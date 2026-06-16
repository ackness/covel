import {
  compactRecord,
  makeProposal,
  normalizeRequiredString,
  optionalString,
  splitList,
} from "@covel/plugin-handlers-utils";
import { playerIdentityToCharacterUpsert } from "@covel/shared";
import { shortId, withPendingProposals } from "@covel/tools";

const PROFILE_NAMESPACE = "profiles";
const BINDING_NAMESPACE = "session-binding";
const CURRENT_BINDING_KEY = "current";
const DEFAULT_MIRROR_PLUGIN_ID = "player-identity";
const MAX_PROFILE_BYTES = 65_536;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const profile = normalizeProfile(readProfilePayload(payload, ctx.sessionId));
  const shouldActivate = payload.activate !== false;
  const shouldBindToPlayer = payload.bindToPlayer !== false;
  const now = new Date().toISOString();
  const existingPlayer = shouldBindToPlayer
    ? await findExistingPlayer(ctx.store, ctx.sessionId)
    : undefined;
  const characterId =
    existingPlayer?.id ?? playerCharacterIdForProfile(profile.id);

  const proposals = [
    makeProposal(ctx, now, "plugin.data", {
      namespace: PROFILE_NAMESPACE,
      key: profile.id,
      value: {
        profile,
        updatedAt: now,
        ...(shouldBindToPlayer ? { boundCharacterId: characterId } : {}),
      },
    }),
  ];

  if (shouldActivate) {
    proposals.push(
      makeProposal(ctx, now, "plugin.data", {
        namespace: BINDING_NAMESPACE,
        key: CURRENT_BINDING_KEY,
        value: {
          profileId: profile.id,
          ...(shouldBindToPlayer ? { characterId } : {}),
          updatedAt: now,
        },
      }),
    );
  }

  if (shouldBindToPlayer) {
    proposals.push(
      makeProposal(
        ctx,
        now,
        "character.upsert",
        playerIdentityToCharacterUpsert(profile, {
          existingPlayer: existingPlayer ?? {
            id: characterId,
            name: profile.name,
          },
          now,
          mirrorPluginId: DEFAULT_MIRROR_PLUGIN_ID,
        }),
      ),
    );
  }

  return withPendingProposals(
    {
      saved: true,
      profileId: profile.id,
      activated: shouldActivate,
      ...(shouldBindToPlayer ? { characterId } : {}),
    },
    proposals,
  );
}

function playerCharacterIdForProfile(profileId) {
  return profileId.startsWith("player-") ? profileId : `player-${profileId}`;
}

function readProfilePayload(payload, sessionId) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (
      typeof payload.profileJson === "string" &&
      payload.profileJson.trim().length > 0
    ) {
      try {
        return JSON.parse(payload.profileJson);
      } catch {
        throw new Error("manualPayload.profileJson must be valid JSON");
      }
    }
    if (payload.profileForm && typeof payload.profileForm === "object") {
      return profileFromForm(
        /** @type {Record<string, unknown>} */ (payload.profileForm),
        sessionId,
      );
    }
    return payload.profile;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} form
 * @param {string} sessionId
 */
function profileFromForm(form, sessionId) {
  const fields = compactRecord({
    origin: optionalString(form.origin),
    className: optionalString(form.className),
    club: optionalString(form.club),
  });
  const name = normalizeRequiredString(form.name, "profile.name");
  const explicitId = optionalString(form.id);
  return {
    schemaVersion: 1,
    id: explicitId ?? shortId("player", name, sessionId),
    name,
    ...(optionalString(form.description)
      ? { description: optionalString(form.description) }
      : {}),
    ...(optionalString(form.voice)
      ? { voice: optionalString(form.voice) }
      : {}),
    ...(splitList(form.goalsText).length > 0
      ? { goals: splitList(form.goalsText) }
      : {}),
    ...(splitList(form.boundariesText).length > 0
      ? { boundaries: splitList(form.boundariesText) }
      : {}),
    ...(optionalString(form.relationshipTone)
      ? { relationshipTone: optionalString(form.relationshipTone) }
      : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/**
 * @param {unknown} value
 */
function normalizeProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manualPayload.profile must be an object");
  }

  const input = /** @type {Record<string, unknown>} */ (value);
  const id = normalizeRequiredString(input.id, "profile.id");
  const name = normalizeRequiredString(input.name, "profile.name");
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error(
      "profile.id must be 1-128 characters using letters, digits, underscore, or hyphen",
    );
  }
  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error("profile.schemaVersion must be 1");
  }

  const profile = {
    ...input,
    schemaVersion: 1,
    id,
    name,
  };
  const serialized = JSON.stringify(profile);
  if (serialized.length > MAX_PROFILE_BYTES) {
    throw new Error("profile is too large; max serialized size is 64KB");
  }
  return profile;
}

async function findExistingPlayer(store, sessionId) {
  if (!store || typeof store !== "object") return undefined;
  const s = /** @type {any} */ (store);
  if (typeof s.listCharacters !== "function") return undefined;
  const rows =
    s.listCharacters.length <= 0
      ? await s.listCharacters()
      : await s.listCharacters(sessionId);
  if (!Array.isArray(rows)) return undefined;
  const player = rows.find(
    (row) => row && typeof row === "object" && row.type === "player",
  );
  if (!player) return undefined;
  return {
    id: String(player.id),
    name: String(player.name),
    type: typeof player.type === "string" ? player.type : "player",
    description:
      typeof player.description === "string" ? player.description : undefined,
    fields: player.fields,
    version: typeof player.version === "number" ? player.version : 1,
    createdAt:
      typeof player.createdAt === "string" ? player.createdAt : undefined,
  };
}
