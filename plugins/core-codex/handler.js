/**
 * core-codex — deterministic function runtime.
 *
 * Extracts a small set of high-signal codex entities from narrator output,
 * persists them to plugin_data, and emits codex-discovery UI cards.
 *
 * @param {import('@covel/plugin-loader').FunctionHandlerContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */

const CATEGORY_META = {
  character: { rarity: 'uncommon', tags: ['人物', '发现'], icon: '👤', borderColor: '#3b82f6', animation: 'fade-in' },
  item: { rarity: 'common', tags: ['物件', '发现'], icon: '⚔️', borderColor: '#6b7280', animation: 'fade-in' },
  location: { rarity: 'common', tags: ['地点', '发现'], icon: '🗺️', borderColor: '#6b7280', animation: 'fade-in' },
  lore: { rarity: 'rare', tags: ['设定', '发现'], icon: '📜', borderColor: '#a855f7', animation: 'shimmer' },
  skill: { rarity: 'uncommon', tags: ['技法', '发现'], icon: '✨', borderColor: '#3b82f6', animation: 'fade-in' },
};

const STOP_TITLES = new Set([
  '环境细节',
  '人群',
  '你的位置',
  '苏婉的状态',
  '选择节点',
  '外门弟子',
  '内门弟子',
  '练气期',
  '试炼大会',
  '地下结构',
  '灵气',
  '宿舍区',
]);

const BAD_TITLE_PREFIXES = [
  '你', '我', '他', '她', '它', '这', '那', '把', '从', '在', '向', '将', '让', '用', '于', '就',
];

const BAD_TITLE_FRAGMENTS = [
  '看见', '带到', '这里', '那里', '刚用', '师姐', '声音', '角落', '前往', '调查', '决定', '观察',
];

const LORE_TERMS = [
  '灵脉',
  '地下结构',
  '试炼大会',
  '灵识',
  '宗门钟楼',
];

export default async function codexHandler(ctx) {
  const { sessionId, pluginId, completedResults, store } = ctx;
  const s = /** @type {any} */ (store);
  const narrator = /** @type {any} */ (completedResults.get('core-narrator'));
  const narrative = typeof narrator?.output?.narrativeOutput === 'string'
    ? narrator.output.narrativeOutput
    : '';

  if (!narrative || typeof s?.listPluginData !== 'function' || typeof s?.setPluginDataBatch !== 'function') {
    return {};
  }

  const existingRows = (await s.listPluginData(sessionId, pluginId, 'entries')) ?? [];
  const existingTitles = new Set(
    existingRows
      .map((row) => row?.value?.title)
      .filter((title) => typeof title === 'string')
      .map((title) => title.trim()),
  );

  const sentences = splitSentences(narrative);
  const discoveries = detectDiscoveries(narrative, sentences, existingTitles).slice(0, 4);
  if (discoveries.length === 0) {
    return {};
  }

  const now = new Date().toISOString();
  const records = discoveries.map((entry) => ({
    id: crypto.randomUUID(),
    sessionId,
    pluginId,
    namespace: 'entries',
    key: entry.entryId,
    value: {
      category: entry.category,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      rarity: entry.rarity,
      unlockedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }));

  await s.setPluginDataBatch(records);

  return {
    entries: discoveries,
    ui: [
      {
        type: 'codex-batch',
        title: `图鉴更新 · ${discoveries.length} 条`,
        entries: discoveries.map((entry) => ({
          entryId: entry.entryId,
          category: entry.category,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          rarity: entry.rarity,
          style: {
            borderColor: entry.style.borderColor,
            icon: entry.style.icon,
            animation: entry.style.animation,
          },
        })),
      },
    ],
  };
}

/**
 * @param {string} narrative
 * @param {string[]} sentences
 * @param {Set<string>} existingTitles
 */
function detectDiscoveries(narrative, sentences, existingTitles) {
  /** @type {Array<ReturnType<typeof makeDiscovery>>} */
  const discoveries = [];
  const seen = new Set(existingTitles);
  /** @type {Array<{ title: string; category: 'character'|'item'|'location'|'lore' }>} */
  const mergedCandidates = [];

  const candidates = [
    ...extractByPattern(narrative, /[一-龥]{2,12}(?:沼泽|坊市|山|峰|谷|林|镇|城|岛|溪|河|湖|海|渊|宫|殿|塔|洞府)/gu, 'location'),
    ...extractByPattern(narrative, /[一-龥]{2,12}(?:宗|门|派|盟|会|阁|宫)/gu, 'lore'),
    ...extractByPattern(narrative, /[一-龥]{1,12}(?:丹|散|膏|飞剑|佩剑|玉佩|法器|灵石|灵鱼)/gu, 'item'),
    ...extractByPattern(narrative, /[一-龥]{2,12}(?:术|法|诀|步|阵|结界|遁术)/gu, 'skill'),
    ...extractFixedTerms(narrative, LORE_TERMS, 'lore'),
  ];

  for (const candidate of candidates) {
    const title = normalizeTitle(candidate.title.trim(), candidate.category);
    if (title.length < 2) continue;
    if (STOP_TITLES.has(title)) continue;
    if (seen.has(title)) continue;
    if (isBadTitle(title)) continue;

    const existing = mergedCandidates.find((item) => item.category === candidate.category && titlesOverlap(item.title, title));
    if (existing) {
      existing.title = preferTitle(existing.title, title);
      continue;
    }
    mergedCandidates.push({ title, category: candidate.category });
  }

  for (const candidate of mergedCandidates) {
    const title = candidate.title;
    const content = explainEntity(title, candidate.category, sentences);
    if (!content) continue;

    seen.add(title);
    discoveries.push(makeDiscovery(candidate.category, title, content));
  }

  return discoveries;
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @param {'location'|'lore'|'item'} category
 */
function extractByPattern(text, pattern, category) {
  /** @type {Array<{ title: string; category: 'location'|'lore'|'item' }>} */
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    const title = match[0]?.trim();
    if (!title) continue;
    matches.push({ title, category });
  }
  return matches;
}

/**
 * @param {string} text
 */
/**
 * @param {string} text
 * @param {readonly string[]} terms
 * @param {'lore'} category
 */
function extractFixedTerms(text, terms, category) {
  return terms
    .filter((term) => text.includes(term))
    .map((term) => ({ title: term, category }));
}

/**
 * @param {string} title
 * @param {'character'|'item'|'location'|'lore'} category
 */
function normalizeTitle(title, category) {
  let next = title.trim().replace(/[，。、“”‘’：:；;（）()【】[\]]/gu, '');
  if (category === 'lore') {
    next = next.replace(/(外门|内门|弟子|长老)$/u, '');
  }
  if (category === 'location') {
    next = next.replace(/^(午后的|春日午后|远处的|这里的)/u, '');
  }
  if (category === 'item') {
    next = next.replace(/^(腰间|手中|袖口|身上|掌中|怀里)/u, '');
  }
  return next.trim();
}

/**
 * @param {string} title
 */
function isBadTitle(title) {
  if (BAD_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) return true;
  if (BAD_TITLE_FRAGMENTS.some((fragment) => title.includes(fragment))) return true;
  return false;
}

/**
 * @param {string} left
 * @param {string} right
 */
function titlesOverlap(left, right) {
  return left.includes(right) || right.includes(left);
}

/**
 * @param {string} left
 * @param {string} right
 */
function preferTitle(left, right) {
  return right.length > left.length ? right : left;
}

/**
 * @param {'character'|'item'|'location'|'lore'} category
 * @param {string} title
 * @param {string} content
 */
function makeDiscovery(category, title, content) {
  const meta = CATEGORY_META[category];
  return {
    entryId: makeEntryId(title),
    category,
    title,
    content,
    tags: Array.from(new Set([meta.tags[0], meta.tags[1], title.length <= 4 ? title : '剧情'])).slice(0, 3),
    rarity: meta.rarity,
    style: {
      icon: meta.icon,
      borderColor: meta.borderColor,
      animation: meta.animation,
    },
  };
}

/**
 * @param {string} title
 * @param {string[]} sentences
 */
function explainEntity(title, category, sentences) {
  const related = sentences.filter((sentence) => sentence.includes(title)).slice(0, 2);
  if (related.length === 0) return '';
  const raw = related.join('').replace(/\s+/g, ' ').trim();
  const content = compressExplanation(title, category, raw);
  return content.length >= 10 ? content : '';
}

/**
 * @param {string} title
 * @param {'character'|'item'|'location'|'lore'|'skill'} category
 * @param {string} raw
 */
function compressExplanation(title, category, raw) {
  const cleaned = raw
    .replace(/^["“”']+|["“”']+$/gu, '')
    .replace(/^[一-龥]{0,6}(?:看见|听见|注意到|发现)/u, '')
    .replace(/^[\s，。！？、：；“”‘’"'（）()【】\-—]+|[\s，。！？、：；“”‘’"'（）()【】\-—]+$/gu, '')
    .trim();

  const templates = {
    location: `${title}：当前剧情中的关键地点，与眼前事件直接相关。`,
    item: `${title}：当前剧情里明确出现的物件，可作为线索或行动资源。`,
    lore: `${title}：当前剧情涉及的重要设定，值得后续继续追踪。`,
    skill: `${title}：当前剧情中出现的技法或行动方式，可能影响接下来的选择。`,
    character: `${title}：当前剧情中明确出现的角色。`,
  };

  if (cleaned.includes('当前剧情')) {
    return cleaned.slice(0, 88);
  }

  return (templates[category] ?? `${title}：当前剧情中的关键术语。`).slice(0, 88);
}

/**
 * @param {string} text
 */
function splitSentences(text) {
  return text
    .split(/(?<=[。！？])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * @param {string} title
 */
function makeEntryId(title) {
  const slug = title
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `codex-${slug || 'entry'}`;
}
