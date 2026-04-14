/**
 * Deterministic player-init handler.
 *
 * Turn 1: emit a character creation form from world schema.
 * Turn 2: consume the latest submitted values, create the player character,
 * and advance the session to playing.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */

function getSchemaAttributes(config) {
  const schemaRoot = /** @type {any} */ (config?.worldSchema);
  const attrs = schemaRoot?.['character-attributes']?.attributes;
  return Array.isArray(attrs) ? attrs : [];
}

function pickPlayerFields(attributes) {
  const picked = [];
  const order = ['bio', 'abilities', 'social', 'equipment', 'stats'];

  for (const category of order) {
    for (const attr of attributes) {
      if (picked.length >= 3) break;
      if (!attr || attr.category !== category) continue;
      if (!attr.id || attr.id === 'name' || attr.id === 'characterName') continue;
      if (attr.type === 'number' && category === 'stats') continue;
      if (picked.some((item) => item.id === attr.id)) continue;
      picked.push(attr);
    }
    if (picked.length >= 3) break;
  }

  return picked;
}

function toFormField(attr) {
  if (attr.type === 'enum' && Array.isArray(attr.options) && attr.options.length > 0) {
    return {
      type: 'select',
      name: attr.id,
      label: attr.name || attr.id,
      options: attr.options.map((option) => String(option)),
      required: false,
      defaultValue: attr.defaultValue != null ? String(attr.defaultValue) : undefined,
    };
  }

  return {
    type: 'text',
    name: attr.id,
    label: attr.name || attr.id,
    placeholder: attr.description || `请输入${attr.name || attr.id}`,
    required: false,
    defaultValue: attr.defaultValue != null ? String(attr.defaultValue) : undefined,
  };
}

function buildNarrativeTemplate(fields) {
  const parts = [
    '你整理好自己的身份与心绪，准备正式进入这段故事。',
    '你的名字是{{characterName}}。',
  ];

  for (const field of fields) {
    parts.push(`你的${field.label}是{{${field.name}}}。`);
  }

  return parts.join('');
}

function buildCharacterDescription(name, values, fields) {
  const details = fields
    .map((field) => {
      const value = values[field.name];
      return value ? `${field.label}为${value}` : '';
    })
    .filter(Boolean)
    .slice(0, 3);

  return details.length > 0
    ? `${name}的身份已经明确，${details.join('，')}。`
    : `${name}已经踏入故事之中，神色专注，准备面对接下来的变化。`;
}

function buildCharacterFields(attributes, values) {
  /** @type {Record<string, unknown>} */
  const fields = {};

  for (const attr of attributes) {
    if (!attr?.id) continue;
    if (attr.id === 'name' || attr.id === 'characterName') continue;

    if (values[attr.id] != null && values[attr.id] !== '') {
      fields[attr.id] = values[attr.id];
      continue;
    }

    if (attr.defaultValue != null) {
      fields[attr.id] = attr.defaultValue;
    }
  }

  return fields;
}

async function mirrorPlayer(store, sessionId, pluginId, player) {
  if (!store || typeof store.setPluginData !== 'function') return;
  const now = new Date().toISOString();
  await store.setPluginData({
    id: `char-mirror-${player.id}`,
    sessionId,
    pluginId,
    namespace: 'characters',
    key: player.id,
    value: player,
    createdAt: now,
    updatedAt: now,
  });
}

export default async function playerInitHandler(ctx) {
  const { sessionId, pluginId, store, config } = ctx;
  const s = /** @type {any} */ (store);
  const attributes = getSchemaAttributes(config);
  const selectableAttrs = pickPlayerFields(attributes);

  /** @type {Array<any>} */
  const playerInputs = typeof s?.listPlayerInputs === 'function'
    ? await s.listPlayerInputs(sessionId)
    : [];
  const latestInput = playerInputs.length > 0 ? playerInputs[playerInputs.length - 1] : null;
  const values = latestInput?.values && typeof latestInput.values === 'object'
    ? /** @type {Record<string, unknown>} */ (latestInput.values)
    : null;

  if (!values) {
    const dynamicFields = selectableAttrs.map(toFormField);
    const formFields = [
      {
        type: 'text',
        name: 'characterName',
        label: '角色名',
        placeholder: '请输入你的角色名',
        required: true,
      },
      ...dynamicFields,
    ];
    const narrativeTemplate = buildNarrativeTemplate(dynamicFields);

    return {
      narrativeOutput: '你需要先确定自己的身份，故事才会继续向前展开。',
      interactions: [
        {
          type: 'form',
          interactionId: 'char-creation',
          title: '创建你的角色',
          fields: formFields,
          submitLabel: '确认角色',
          narrativeTemplate,
          submitBehavior: {
            echoFilledNarrative: false,
            autoContinue: true,
          },
        },
      ],
      form: {
        formId: 'char-creation',
        title: '创建你的角色',
        fields: formFields,
        submitLabel: '确认角色',
        submitBehavior: {
          echoFilledNarrative: false,
          autoContinue: true,
        },
      },
      narrativeTemplate,
    };
  }

  const name = String(values.characterName || values.name || '无名弟子').trim() || '无名弟子';
  const characterFields = buildCharacterFields(attributes, values);
  const now = new Date().toISOString();
  const playerId = `char-${crypto.randomUUID()}`;
  const player = {
    id: playerId,
    sessionId,
    name,
    type: 'player',
    description: buildCharacterDescription(name, values, selectableAttrs),
    fields: characterFields,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  if (typeof s?.upsertCharacter === 'function') {
    await s.upsertCharacter(player);
  }
  await mirrorPlayer(s, sessionId, pluginId, player);

  return {
    narrativeOutput: `${name}的身份已经确定。故事从这一刻正式展开。`,
    phase: 'playing',
    playerCreated: true,
    playerId,
  };
}
