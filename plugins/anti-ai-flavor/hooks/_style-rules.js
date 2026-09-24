/**
 * Style-rule text appended to the story runtime's assembled system prompt by
 * ./inject-style-rules.js. Plain frozen text constants — no runtime state,
 * no I/O. Kept in its own module so the handler and tests share one source
 * of truth.
 *
 * Two rule tables: zh (Chinese prose conventions — 破折号 / 解释性冒号 /
 * 指节泛白 / 账簿比喻) and en (English AI-slop patterns — throat-clearing /
 * vague declaratives / false agency). The handler picks the table by session
 * locale; other locales get nothing. The phrasing states intent and
 * exemptions directly instead of enumerating banned patterns — prevention
 * lives on the model's understanding, not on post-hoc matching.
 *
 * Setting keys are per-rule and shared across tables where the same concept
 * exists in both languages (e.g. `banCorrectiveNegation`); a key whose rule
 * is absent from the active table is simply skipped. Rules are grouped into
 * three categories (mirroring the authoring intent):
 *   1. 避免说明文写法 / formulaic structures.
 *   2. 避免 AI 高频陈词 / AI-frequent clichés.
 *   3. 增强活人感 / human liveliness (zh only so far).
 */

// ── zh table ───────────────────────────────────────────────────

/** @type {string} */
export const STYLE_RULES_HEADER = "## 正文文风要求";

/** @type {string} */
export const STYLE_RULES_INTRO =
  "以下规则用于去除说明文腔、避开 AI 高频陈词、增强活人感：";

// ── Category 1: 避免说明文写法 ─────────────────────────────────

/** @type {string} */
export const CATEGORY_EXPOSITORY = "### 避免说明文写法";

/** @type {string} */
export const RULE_NEGATION =
  "只写是什么、发生了什么，不通过“不是什么、没发生什么”来描写。人物对话、成语与固定搭配、内心独白不受此限。确需表现“寻求而无果”时（如寻找未果、无人应答）可以使用否定表述，但同一段落内必须写出实际发生的动作或状态，不允许整段只有否定。";

/** @type {string} */
export const RULE_CORRECTIVE_NEGATION =
  "不使用“不是……（而）是……”的先否定再纠正句式，包括把否定与纠正拆进不同句子或段落的变体；直接写是什么，不用否定句铺垫。";

/** @type {string} */
export const RULE_EM_DASH =
  "不使用破折号，表示声音拉长时除外；表达解释或转折时，改用逗号。";

/** @type {string} */
export const RULE_EXPLANATORY_COLON =
  "不使用冒号进行解释，引出人物话语的冒号不受此限；需要解释时，改用逗号衔接。";

// ── Category 2: 避免 AI 高频陈词 ───────────────────────────────

/** @type {string} */
export const CATEGORY_AI_CLICHE = "### 避免 AI 高频陈词";

/** @type {string} */
export const RULE_FINGER_CLICHE =
  "不使用“指节泛白”及类似的手指描写；表现紧张、用力时，改用其他身体细节。";

/** @type {string} */
export const RULE_DEGREE_ADVERBS =
  "减少“一丝”“一抹”“微微”“淡淡”“难以察觉的”“极其”等程度副词与弱化修饰的使用，禁止短时间内连续出现；要写就写出具体的程度、形态或动作。";

/** @type {string} */
export const RULE_ACCOUNTING_METAPHOR =
  "不把“记账”“算账”“账目”“这笔账”等账簿词汇用作抽象比喻（情绪、恩怨、因果的“账”）；真实的记账动作与真实存在的账簿不受此限，要表达亏欠与清算就写具体的事和行为。";

// ── Category 3: 增强活人感 ─────────────────────────────────────

/** @type {string} */
export const CATEGORY_LIVELINESS = "### 增强活人感";

/** @type {string} */
export const RULE_FLAT_VOICE =
  "不使用“声音很平”“声音不大”这类无情绪、无特点的声音描述；写声音就写出它的质感、情绪或节奏。";

/** @type {string} */
export const RULE_VERBATIM_ECHO =
  "人物对话复述前文内容时，不逐字或原封不动地照抄原文；同样的意思也要换一种说法。";

/** @type {string} */
export const RULE_COLLOQUIAL_SPEECH =
  "人物说话要口语化，不使用书面语；可以多用语气词和符合人物习惯的口癖。";

// ── en table ───────────────────────────────────────────────────

/** @type {string} */
export const STYLE_RULES_HEADER_EN = "## Prose Style Requirements";

/** @type {string} */
export const STYLE_RULES_INTRO_EN =
  "The following rules remove formulaic structures and AI-frequent clichés from the prose:";

/** @type {string} */
export const CATEGORY_FORMULAIC_EN = "### Avoid formulaic structures";

/** @type {string} */
export const RULE_CORRECTIVE_NEGATION_EN =
  "No \"not X but Y\" negate-then-correct constructions (\"The answer isn't X. It's Y.\"), including variants split across sentences or paragraphs; state what is, directly.";

/** @type {string} */
export const RULE_EM_DASH_EN =
  "No em dashes; use commas or periods instead.";

/** @type {string} */
export const RULE_THROAT_CLEARING_EN =
  "No throat-clearing openers or emphasis crutches (\"Here's the thing:\", \"It turns out\", \"The truth is\", \"Let that sink in.\", \"Make no mistake\"); state the point directly.";

/** @type {string} */
export const RULE_TRIADIC_LISTS_EN =
  "No three-item lists or staccato fragments stacked for drama (\"Speed. Quality. Cost.\"); vary rhythm — two items beat three.";

/** @type {string} */
export const CATEGORY_AI_CLICHE_EN = "### Avoid AI-frequent clichés";

/** @type {string} */
export const RULE_DEGREE_ADVERBS_EN =
  "Cut hedging degree adverbs and intensifiers (\"slightly\", \"faintly\", \"barely\", \"imperceptibly\", \"incredibly\", \"extremely\") and never stack them in quick succession; state the concrete degree, form, or action instead.";

/** @type {string} */
export const RULE_VAGUE_DECLARATIVES_EN =
  "No vague declaratives that announce importance without naming the thing (\"The stakes are high\", \"The reasons are structural\"); name the specific stake or reason.";

/** @type {string} */
export const RULE_FALSE_AGENCY_EN =
  "No false agency — inanimate things do not perform human actions (\"the decision emerges\", \"the data tells us\"); name the person who acts.";

/** @type {string} */
export const RULE_BUSINESS_JARGON_EN =
  "No business jargon (\"navigate\", \"unpack\", \"lean into\", \"landscape\", \"game-changer\", \"double down\", \"deep dive\"); use plain language.";

/**
 * Category headers + setting key → rule text, in injected order. The keys
 * mirror the `userSettings` declarations in ../PLUGIN.md.
 * @type {Readonly<Record<"zh" | "en", ReadonlyArray<{ header: string, rules: ReadonlyArray<readonly [string, string]> }>>>}
 */
const TABLES = Object.freeze({
  zh: Object.freeze([
    {
      header: CATEGORY_EXPOSITORY,
      rules: Object.freeze([
        ["banNegation", RULE_NEGATION],
        ["banCorrectiveNegation", RULE_CORRECTIVE_NEGATION],
        ["banEmDash", RULE_EM_DASH],
        ["banExplanatoryColon", RULE_EXPLANATORY_COLON],
      ]),
    },
    {
      header: CATEGORY_AI_CLICHE,
      rules: Object.freeze([
        ["banFingerCliche", RULE_FINGER_CLICHE],
        ["banDegreeAdverbs", RULE_DEGREE_ADVERBS],
        ["banAccountingMetaphor", RULE_ACCOUNTING_METAPHOR],
      ]),
    },
    {
      header: CATEGORY_LIVELINESS,
      rules: Object.freeze([
        ["banFlatVoice", RULE_FLAT_VOICE],
        ["banVerbatimEcho", RULE_VERBATIM_ECHO],
        ["colloquialDialogue", RULE_COLLOQUIAL_SPEECH],
      ]),
    },
  ]),
  en: Object.freeze([
    {
      header: CATEGORY_FORMULAIC_EN,
      rules: Object.freeze([
        ["banCorrectiveNegation", RULE_CORRECTIVE_NEGATION_EN],
        ["banEmDash", RULE_EM_DASH_EN],
        ["banThroatClearing", RULE_THROAT_CLEARING_EN],
        ["banTriadicLists", RULE_TRIADIC_LISTS_EN],
      ]),
    },
    {
      header: CATEGORY_AI_CLICHE_EN,
      rules: Object.freeze([
        ["banDegreeAdverbs", RULE_DEGREE_ADVERBS_EN],
        ["banVagueDeclaratives", RULE_VAGUE_DECLARATIVES_EN],
        ["banFalseAgency", RULE_FALSE_AGENCY_EN],
        ["banBusinessJargon", RULE_BUSINESS_JARGON_EN],
      ]),
    },
  ]),
});

const HEADERS = Object.freeze({
  zh: [STYLE_RULES_HEADER, STYLE_RULES_INTRO],
  en: [STYLE_RULES_HEADER_EN, STYLE_RULES_INTRO_EN],
});

/**
 * Build the injected style-rules block from this plugin's resolved settings.
 * Every rule defaults to ON when its setting is absent (the manifest declares
 * `default: true`; the `?? true` fallback keeps out-of-hook-scope callers on
 * the same behaviour). Disabled rules are dropped, the survivors are
 * renumbered gap-free (numbering runs continuously across categories), and a
 * category whose rules are all disabled is omitted header and all. A setting
 * key with no rule in the active language's table is skipped silently.
 *
 * @param {Record<string, unknown> | undefined} settings
 * @param {"zh" | "en"} [lang]
 * @returns {string} The assembled block, or "" when every rule is off.
 */
export function buildStyleRulesText(settings, lang = "zh") {
  const categories = TABLES[lang];
  const [header, intro] = HEADERS[lang];
  const sections = [];
  let counter = 0;
  for (const category of categories) {
    const lines = [];
    for (const [key, text] of category.rules) {
      if (!(settings?.[key] ?? true)) continue;
      counter += 1;
      lines.push(`${counter}. ${text}`);
    }
    if (lines.length > 0) sections.push([category.header, ...lines]);
  }
  if (sections.length === 0) return "";
  return [
    header,
    "",
    intro,
    "",
    sections.map((section) => section.join("\n")).join("\n\n"),
  ].join("\n");
}
