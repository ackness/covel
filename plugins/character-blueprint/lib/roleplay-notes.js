/**
 * The roleplay material of the world's character cards as one prompt
 * segment for the narrative: voice, manner, traits, goals, fears, secrets,
 * relationships, rules and example lines. The card's attributes are not
 * here; they are the character's fields, which the narrative already has.
 */
import { estimateTokens, pickLocaleText } from "@covel/plugin-handlers-utils";

// The segment is session-stable text in the system prompt: a provider's
// prefix cache covers it, but it is sent with every narrative call. 6000
// estimated tokens hold the full notes of the largest bundled cast (seven
// characters, each with rules and example lines) in either language; a
// budget in characters would give a Chinese world three times the room.
export const NOTES_TOKEN_BUDGET = 6000;
// One line of a card. A voice or a rule is a sentence or two; a longer text
// is a card written as an essay, and one such card must not take the budget.
const LINE_CAP = 300;
// The first lines show the voice; more of them add length, not information.
const MAX_EXAMPLES = 2;
const MAX_RULES = 3;
const MAX_LIST_ITEMS = 4;

/**
 * How much of each card is written, from everything down to the voice
 * alone. The first level that fits the budget is used for every card, so
 * the text of one card does not depend on which card is longest. Example
 * lines go first and rules next; the voice line is never dropped.
 */
const DETAIL_LEVELS = [
  { examples: MAX_EXAMPLES, rules: MAX_RULES, context: true, persona: true },
  { examples: 1, rules: MAX_RULES, context: true, persona: true },
  { examples: 0, rules: MAX_RULES, context: true, persona: true },
  { examples: 0, rules: 1, context: true, persona: true },
  { examples: 0, rules: 0, context: false, persona: true },
  { examples: 0, rules: 0, context: false, persona: false },
];

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const capped = (value) =>
  value.length > LINE_CAP ? `${value.slice(0, LINE_CAP)}...` : value;
const texts = (value) =>
  (Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
/** Content between tags must not be able to close its own tag. */
const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
// Code-unit compare keeps the text identical across ICU builds.
const codeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function labels(locale) {
  const pick = (zh, en) => pickLocaleText(locale, zh, en);
  return {
    intro: pick(
      "下面是世界作者为这些角色写的扮演说明。写这些角色的台词和举动时照着说明来。“秘密”只有你知道：让它影响角色的行为，在故事揭开它之前不要直接说出来。“开场状态”里的值没有保存在任何地方：根据已经发生的故事判断它是否变了。规则提到的属性如果是角色已有的字段，照常用角色工具修改。“示例台词”只用来示范口吻，不要照抄。",
      'These are the world author\'s notes for playing the characters below. Write each character\'s speech and actions to match the notes. A "secret" is known only to you: let it shape what the character does, and do not state it before the story reveals it. The values under "state at start" are not stored anywhere: judge from the story so far whether one has changed. When a rule names an attribute that is one of the character\'s fields, change it with the character tools as usual. The "example lines" show the voice; do not copy them.',
    ),
    sep: pick("；", "; "),
    colon: pick("：", ": "),
    player: pick("玩家", "player"),
    voice: pick("口吻", "Voice"),
    manner: pick("举止", "Manner"),
    summary: pick("概述", "Summary"),
    traits: pick("性格", "Traits"),
    goals: pick("目标", "Goals"),
    fears: pick("恐惧", "Fears"),
    secrets: pick("秘密（只有你知道）", "Secrets (known only to you)"),
    relationships: pick("关系", "Relationships"),
    state: pick("开场状态", "State at start"),
    rules: pick("规则", "Rules"),
    examples: pick("示例台词", "Example lines"),
    omitted: pick("未列出说明", "notes not shown"),
    nameSep: pick("、", ", "),
  };
}

/** A card's rules, the most important first; the order written breaks ties. */
function ruleTexts(card) {
  return (Array.isArray(card.rules) ? card.rules : [])
    .filter((rule) => isRecord(rule) && text(rule.text))
    .map((rule, index) => ({
      text: text(rule.text),
      priority: typeof rule.priority === "number" ? rule.priority : 0,
      index,
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((rule) => rule.text);
}

function exampleLines(card, l) {
  return (Array.isArray(card.dialogueExamples) ? card.dialogueExamples : [])
    .filter((example) => isRecord(example) && text(example.character))
    .map((example) => {
      const prompt = text(example.user);
      const reply = text(example.character);
      return prompt ? `${l.player}${l.colon}${prompt} → ${reply}` : reply;
    });
}

function renderCard(entry, level, names, l) {
  const { card, name } = entry;
  const persona = isRecord(card.persona) ? card.persona : {};
  const defaults = isRecord(card.scenarioDefaults) ? card.scenarioDefaults : {};
  const lines = [];
  const line = (label, value) => {
    if (value) lines.push(`${label}${l.colon}${capped(value)}`);
  };
  const list = (label, values, max) => {
    const shown = values.slice(0, max);
    if (shown.length === 0) return;
    lines.push(
      `${label}${l.colon}`.trimEnd(),
      ...shown.map((value) => `- ${capped(value)}`),
    );
  };

  line(l.voice, text(persona.voice));
  line(l.manner, text(persona.style));
  if (level.persona) {
    line(l.summary, text(persona.summary));
    line(l.traits, texts(persona.traits).join(l.sep));
    line(l.goals, texts(persona.goals).join(l.sep));
    line(l.fears, texts(persona.fears).join(l.sep));
  }
  line(l.secrets, texts(persona.secrets).join(l.sep));
  if (level.context) {
    if (isRecord(defaults.relationships))
      line(
        l.relationships,
        Object.entries(defaults.relationships)
          .filter(([, value]) => text(value))
          .slice(0, MAX_LIST_ITEMS)
          // A model knows a character by name, not by the card's id.
          .map(
            ([id, value]) =>
              `${id === "player" ? l.player : (names.get(id) ?? id)}${l.colon}${text(value)}`,
          )
          .join(l.sep),
      );
    if (isRecord(defaults.state) && Object.keys(defaults.state).length > 0)
      line(l.state, JSON.stringify(defaults.state));
  }
  list(l.rules, ruleTexts(card), level.rules);
  list(l.examples, exampleLines(card, l), level.examples);
  if (lines.length === 0) return "";
  return `## ${name}\n${lines.join("\n")}`;
}

/**
 * The cards of the characters that are in the session. A card belongs to the
 * character with its id, or with `npc-<id>`: the same match the portrait
 * projection uses. The player's own card is left out; the narrative does not
 * speak for the player.
 */
function matchCards(rows, characters) {
  const byId = new Map(
    characters.map((character) => [character.id, character]),
  );
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    const card = row?.value;
    if (!isRecord(card) || typeof card.id !== "string") continue;
    const character = byId.get(card.id) ?? byId.get(`npc-${card.id}`);
    if (!character || character.type === "player" || seen.has(character.id))
      continue;
    seen.add(character.id);
    entries.push({ card, name: character.name });
  }
  return entries.sort((a, b) => codeUnit(a.card.id, b.card.id));
}

/**
 * Names of the entries the world's dimensions list (a faction, a place), by
 * id. A card may name one as the other side of a relationship, and the model
 * reads names, not ids.
 */
function dimensionEntryNames(dimensions) {
  const names = [];
  for (const dimension of Object.values(dimensions ?? {})) {
    if (!Array.isArray(dimension?.value)) continue;
    for (const item of dimension.value) {
      if (
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string"
      )
        names.push([item.id, item.name]);
    }
  }
  return names;
}

/**
 * The `prompt.segment@1` output: one session-stable segment for story
 * runtimes, or none when no card has a character in the session or no
 * matched card has roleplay material.
 */
export function roleplayNoteSegments(rows, characters, locale, dimensions) {
  const entries = matchCards(rows, characters);
  if (entries.length === 0) return [];
  const l = labels(locale);
  const names = new Map([
    ...dimensionEntryNames(dimensions),
    ...entries.map(({ card, name }) => [card.id, name]),
  ]);
  const room = NOTES_TOKEN_BUDGET - estimateTokens(l.intro);

  let blocks = [];
  for (const level of DETAIL_LEVELS) {
    blocks = entries
      .map((entry) => {
        const text = escapeXml(renderCard(entry, level, names, l));
        return { name: entry.name, text, tokens: estimateTokens(text) };
      })
      .filter((block) => block.text);
    const size = blocks.reduce((sum, block) => sum + block.tokens, 0);
    if (size <= room) break;
  }
  if (blocks.length === 0) return [];

  // A cast too large even at the last level: the first cards in id order
  // are written, the rest are named so the model knows notes exist.
  const shown = [];
  const omitted = [];
  let used = 0;
  for (const block of blocks) {
    if (omitted.length > 0 || used + block.tokens > room) {
      omitted.push(block.name);
      continue;
    }
    shown.push(block.text);
    used += block.tokens;
  }
  if (omitted.length > 0)
    shown.push(escapeXml(`(${l.omitted}${l.colon}${omitted.join(l.nameSep)})`));

  return [
    {
      id: "character-notes",
      content: `<character-notes>\n${l.intro}\n${shown.join("\n")}\n</character-notes>`,
      position: "system",
      audience: "story",
      volatility: "session",
    },
  ];
}
