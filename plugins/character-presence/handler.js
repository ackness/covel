import {
  assertEntityEnvelope,
  makeProposal,
  normalizeRequiredString,
  optionalInteger,
  optionalString,
  readManualEntity,
} from "@covel/plugin-handlers-utils";
import { shortId, withPendingProposals } from "@covel/tools";

const PRESENCE_NAMESPACE = "presence";
const CHARACTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const presence = normalizePresence(
    readManualEntity(payload, "presence", (form) =>
      presenceFromForm(form, ctx.sessionId),
    ),
  );
  const now = new Date().toISOString();

  const proposal = makeProposal(ctx, now, "plugin.data", {
    namespace: PRESENCE_NAMESPACE,
    key: presence.characterId,
    // Flat shape — matches the world seed (media/presence.json), the schema,
    // and every frontend read site (stage-selectors, portrait-gallery-panel,
    // character-avatar-renderer). Records are keyed by characterId and fully
    // overwritten each RPC, so any legacy wrapped record self-heals on rewrite.
    value: {
      ...presence,
      updatedAt: now,
    },
  });

  return withPendingProposals(
    {
      saved: true,
      characterId: presence.characterId,
    },
    [proposal],
  );
}

/**
 * @param {Record<string, unknown>} form
 * @param {string} sessionId
 */
function presenceFromForm(form, sessionId) {
  const displayName = optionalString(form.displayName);
  const presence = {
    schemaVersion: 1,
    characterId:
      optionalString(form.characterId) ??
      shortId(
        "npc",
        displayName ?? optionalString(form.style) ?? "presence",
        sessionId,
      ),
    ...(displayName ? { displayName } : {}),
    ...(optionalString(form.style)
      ? { style: optionalString(form.style) }
      : {}),
    ...(mediaRefFromForm(form, "avatar")
      ? { avatar: mediaRefFromForm(form, "avatar") }
      : {}),
    ...(mediaRefFromForm(form, "sprite")
      ? { sprite: mediaRefFromForm(form, "sprite") }
      : {}),
    ...(mediaRefFromForm(form, "voice")
      ? { voice: mediaRefFromForm(form, "voice") }
      : {}),
  };
  const extraKey = optionalString(form.mediaKey);
  const extraRef = mediaRefFromForm(form, "media");
  return extraKey && extraRef
    ? { ...presence, media: { [extraKey]: extraRef } }
    : presence;
}

/**
 * @param {Record<string, unknown>} form
 * @param {string} prefix
 */
function mediaRefFromForm(form, prefix) {
  const id = optionalString(form[`${prefix}Id`]);
  const mime = optionalString(form[`${prefix}Mime`]);
  const size = optionalInteger(form[`${prefix}Size`]);
  if (!id && !mime && size === undefined) return undefined;
  return {
    id: id ?? "",
    mime: mime ?? "",
    size: size ?? -1,
    ...(optionalString(form[`${prefix}Url`])
      ? { url: optionalString(form[`${prefix}Url`]) }
      : {}),
  };
}

/**
 * @param {unknown} value
 */
function normalizePresence(value) {
  return assertEntityEnvelope(value, {
    entity: "presence",
    idField: "characterId",
    idPattern: CHARACTER_ID_PATTERN,
    idError:
      "presence.characterId must be 1-128 characters using letters, digits, underscore, hyphen, dot, colon, or slash-free ids",
    build: (base) => ({
      ...base,
      ...(base.avatar !== undefined
        ? { avatar: normalizeMediaRef(base.avatar, "presence.avatar") }
        : {}),
      ...(base.sprite !== undefined
        ? { sprite: normalizeMediaRef(base.sprite, "presence.sprite") }
        : {}),
      ...(base.voice !== undefined
        ? { voice: normalizeMediaRef(base.voice, "presence.voice") }
        : {}),
      ...(base.media !== undefined
        ? { media: normalizeMediaMap(base.media) }
        : {}),
    }),
  });
}

function normalizeMediaMap(value) {
  if (!isRecord(value)) {
    throw new Error("presence.media must be an object map of MediaRef values");
  }
  const out = {};
  for (const [key, mediaRef] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(key)) {
      throw new Error("presence.media keys must be 1-64 safe characters");
    }
    out[key] = normalizeMediaRef(mediaRef, `presence.media.${key}`);
  }
  return out;
}

function normalizeMediaRef(value, field) {
  if (!isRecord(value)) {
    throw new Error(`${field} must be a MediaRef object`);
  }
  const id = normalizeRequiredString(value.id, `${field}.id`);
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error(
      `${field}.id must be a 64-character lowercase sha256 hex string`,
    );
  }
  const mime = normalizeRequiredString(value.mime, `${field}.mime`);
  if (
    typeof value.size !== "number" ||
    !Number.isInteger(value.size) ||
    value.size < 0
  ) {
    throw new Error(`${field}.size must be a non-negative integer`);
  }
  return {
    id,
    mime,
    size: value.size,
    ...(typeof value.url === "string" && value.url.length > 0
      ? { url: value.url }
      : {}),
    ...(isRecord(value.meta) ? { meta: value.meta } : {}),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
