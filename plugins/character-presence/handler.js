import { withPendingProposals } from '@covel/tools';

const PRESENCE_NAMESPACE = 'presence';
const MAX_PRESENCE_BYTES = 65_536;
const CHARACTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const payload = ctx.manualPayload ?? {};
  const presence = normalizePresence(readPresencePayload(payload));
  const now = new Date().toISOString();

  const proposal = {
    id: crypto.randomUUID(),
    type: 'plugin.data',
    source: { pluginId: ctx.pluginId, runtimeId: ctx.runtimeId ?? ctx.pluginId },
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: {
      namespace: PRESENCE_NAMESPACE,
      key: presence.characterId,
      value: {
        presence,
        updatedAt: now,
      },
    },
    timestamp: now,
  };

  return withPendingProposals(
    {
      saved: true,
      characterId: presence.characterId,
    },
    [proposal],
  );
}

function readPresencePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.presenceJson === 'string') {
      try {
        return JSON.parse(payload.presenceJson);
      } catch {
        throw new Error('manualPayload.presenceJson must be valid JSON');
      }
    }
    return payload.presence;
  }
  return undefined;
}

/**
 * @param {unknown} value
 */
function normalizePresence(value) {
  if (!isRecord(value)) {
    throw new Error('manualPayload.presence must be an object');
  }

  const characterId = normalizeRequiredString(value.characterId, 'presence.characterId');
  if (!CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error('presence.characterId must be 1-128 characters using letters, digits, underscore, hyphen, dot, colon, or slash-free ids');
  }
  const schemaVersion = value.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error('presence.schemaVersion must be 1');
  }

  const presence = {
    ...value,
    schemaVersion: 1,
    characterId,
    ...(value.avatar !== undefined ? { avatar: normalizeMediaRef(value.avatar, 'presence.avatar') } : {}),
    ...(value.sprite !== undefined ? { sprite: normalizeMediaRef(value.sprite, 'presence.sprite') } : {}),
    ...(value.voice !== undefined ? { voice: normalizeMediaRef(value.voice, 'presence.voice') } : {}),
    ...(value.media !== undefined ? { media: normalizeMediaMap(value.media) } : {}),
  };
  const serialized = JSON.stringify(presence);
  if (serialized.length > MAX_PRESENCE_BYTES) {
    throw new Error('presence is too large; max serialized size is 64KB');
  }
  return presence;
}

function normalizeMediaMap(value) {
  if (!isRecord(value)) {
    throw new Error('presence.media must be an object map of MediaRef values');
  }
  const out = {};
  for (const [key, mediaRef] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(key)) {
      throw new Error('presence.media keys must be 1-64 safe characters');
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
    throw new Error(`${field}.id must be a 64-character lowercase sha256 hex string`);
  }
  const mime = normalizeRequiredString(value.mime, `${field}.mime`);
  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0) {
    throw new Error(`${field}.size must be a non-negative integer`);
  }
  return {
    id,
    mime,
    size: value.size,
    ...(typeof value.url === 'string' && value.url.length > 0 ? { url: value.url } : {}),
    ...(isRecord(value.meta) ? { meta: value.meta } : {}),
  };
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
