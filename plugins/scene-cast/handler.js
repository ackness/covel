import { withPendingProposals } from '@covel/tools';

const ACTIVE_CAST_NAMESPACE = 'active-cast';
const ACTIVE_CAST_KEY = 'current';
const DEFAULT_MAX_SPEAKERS = 2;

/**
 * Choose active speakers for Chat Mode before narration.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export default async function handler(ctx) {
  const turnId = ctx.turnId;
  const playerMessage = String(ctx.playerMessage ?? '');
  const maxSpeakers = resolveMaxSpeakers(ctx.userSettings?.activeSpeakerCount);

  const [characters, messages, previousCast] = await Promise.all([
    listCharacters(ctx.store, ctx.sessionId),
    listTurnMessages(ctx.store, ctx.sessionId, 12),
    readPreviousCast(ctx),
  ]);

  const candidates = characters
    .filter((character) => character.type !== 'player')
    .map((character) => scoreCharacter(character, {
      playerMessage,
      messages,
      previousCast,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .slice(0, maxSpeakers);

  if (selected.length === 0) {
    const activeCast = {
      speakers: [],
      reason: 'No named NPC has enough current scene salience yet.',
      turnId,
      updatedAt: new Date().toISOString(),
    };
    return withPendingProposals({
      activeCastContext: formatActiveCastContext(activeCast),
      speakers: [],
    }, [makePluginDataProposal(ctx, activeCast)]);
  }

  const speakers = selected.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    description: candidate.description,
    score: candidate.score,
    signals: candidate.signals,
  }));
  const activeCast = {
    speakers,
    reason: selected.map((candidate) => `${candidate.name}: ${candidate.signals.join(', ')}`).join('; '),
    turnId,
    updatedAt: new Date().toISOString(),
  };

  return withPendingProposals({
    activeCastContext: formatActiveCastContext(activeCast),
    speakers,
  }, [makePluginDataProposal(ctx, activeCast)]);
}

function makePluginDataProposal(ctx, activeCast) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    type: 'plugin.data',
    source: {
      pluginId: ctx.pluginId,
      runtimeId: ctx.runtimeId ?? ctx.pluginId,
    },
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    payload: {
      namespace: ACTIVE_CAST_NAMESPACE,
      key: ACTIVE_CAST_KEY,
      value: activeCast,
    },
    timestamp: now,
  };
}

function resolveMaxSpeakers(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_SPEAKERS;
  return Math.max(1, Math.min(4, Math.round(numeric)));
}

async function readPreviousCast(ctx) {
  if (ctx.pluginData && typeof ctx.pluginData.get === 'function') {
    const value = await ctx.pluginData.get(ACTIVE_CAST_NAMESPACE, ACTIVE_CAST_KEY);
    return normalizePreviousCast(value);
  }

  const row = await getPluginData(ctx.store, ctx.sessionId, ctx.pluginId, ACTIVE_CAST_NAMESPACE, ACTIVE_CAST_KEY);
  return normalizePreviousCast(row?.value);
}

function normalizePreviousCast(value) {
  if (!value || typeof value !== 'object') return [];
  const speakers = Array.isArray(value.speakers) ? value.speakers : [];
  return speakers
    .map((speaker) => typeof speaker?.id === 'string' ? speaker.id : null)
    .filter(Boolean);
}

function scoreCharacter(character, context) {
  const name = character.name ?? '';
  const description = character.description ?? '';
  const fieldsText = stringifyCompact(character.fields);
  const haystack = `${context.playerMessage}\n${messagesToText(context.messages)}`.toLowerCase();
  const nameLower = name.toLowerCase();

  let score = 0;
  const signals = [];

  if (nameLower.length > 0 && context.playerMessage.toLowerCase().includes(nameLower)) {
    score += 6;
    signals.push('mentioned by player');
  }

  if (nameLower.length > 0 && haystack.includes(nameLower)) {
    score += 3;
    signals.push('present in recent messages');
  }

  if (description.length > 0 && nameLower.length > 0 && haystack.includes(nameLower)) {
    score += 1;
    signals.push('has character profile');
  }

  if (fieldsText.length > 2 && nameLower.length > 0 && haystack.includes(nameLower)) {
    score += 1;
    signals.push('has tracked state');
  }

  if (context.previousCast.includes(character.id)) {
    score += 1;
    signals.push('recently active');
  }

  return {
    id: character.id,
    name,
    type: character.type,
    description,
    score,
    signals,
  };
}

function messagesToText(messages) {
  return messages
    .map((message) => {
      if (typeof message?.content === 'string') return message.content;
      if (typeof message?.text === 'string') return message.text;
      if (typeof message?.block?.content === 'string') return message.block.content;
      return '';
    })
    .join('\n');
}

function stringifyCompact(value) {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatActiveCastContext(activeCast) {
  if (!Array.isArray(activeCast.speakers) || activeCast.speakers.length === 0) {
    return [
      '## Active Cast',
      '- No active NPC selected. Let the scene breathe or introduce a character already supported by the current world state.',
      `- Reason: ${activeCast.reason}`,
    ].join('\n');
  }

  const lines = ['## Active Cast'];
  for (const speaker of activeCast.speakers) {
    const parts = [
      `- ${speaker.name}`,
      speaker.description ? `: ${speaker.description}` : '',
      speaker.signals?.length ? ` [${speaker.signals.join('; ')}]` : '',
    ];
    lines.push(parts.join(''));
  }
  lines.push(`Reason: ${activeCast.reason}`);
  return lines.join('\n');
}

async function listCharacters(store, sessionId) {
  if (!store || typeof store !== 'object') return [];
  const s = /** @type {any} */ (store);
  if (typeof s.listCharacters === 'function') {
    const rows = await s.listCharacters(sessionId);
    return normalizeCharacters(rows);
  }
  return [];
}

async function listTurnMessages(store, sessionId, limit) {
  if (!store || typeof store !== 'object') return [];
  const s = /** @type {any} */ (store);
  if (typeof s.listTurnMessages !== 'function') return [];
  if (s.listTurnMessages.length <= 1) {
    return await s.listTurnMessages(limit);
  }
  return await s.listTurnMessages(sessionId, { limit });
}

async function getPluginData(store, sessionId, pluginId, namespace, key) {
  if (!store || typeof store !== 'object') return null;
  const s = /** @type {any} */ (store);
  if (typeof s.getPluginData !== 'function') return null;
  if (s.getPluginData.length <= 2) {
    return await s.getPluginData(namespace, key);
  }
  return await s.getPluginData(sessionId, pluginId, namespace, key);
}

function normalizeCharacters(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      id: String(row.id ?? row.name ?? ''),
      name: String(row.name ?? ''),
      type: String(row.type ?? 'npc'),
      description: typeof row.description === 'string' ? row.description : '',
      fields: row.fields,
    }))
    .filter((row) => row.id.length > 0 && row.name.length > 0);
}
