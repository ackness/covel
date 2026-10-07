import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  localeDisplayName,
  modelFacingJson,
  resolveI18nText,
} from "@covel/plugin-handlers-utils";
function buildSystemPrompt(blocks, lang, locale) {
  const canonicalLocale = canonicalizeLocale(locale) ?? DEFAULT_LOCALE;
  const languageName = localeDisplayName(canonicalLocale);
  if (lang === "zh") {
    const languageInstruction = `[LANGUAGE] 所有自然语言的记忆内容必须用${languageName}（${canonicalLocale}）书写。`;
    const descriptions = blocks
      .map(
        (b) =>
          `- **${b.label}**：${resolveI18nText(b.extractionHint, locale) ?? ""}`,
      )
      .join("\n");
    return `你是一个记忆管理器。你的任务是根据本轮新发生的故事事件，更新游戏的核心记忆块。

## 记忆块说明

${descriptions}

## 输出格式

只输出一个 JSON 对象，key 是需要更新的块标签，value 是**完整的新内容**（不是增量）。
只输出有变化的块。如果本轮没有值得更新的信息，输出 \`{}\`。

每个块内容控制在 300-500 字以内，使用简洁的事实陈述，不要用文学化的描写。
如果用户消息中的“会话事实（权威）”与叙事、推断或旧记忆冲突，必须以会话事实为准。

示例输出（用实际的块标签替换）：

\`\`\`json
{ "<块标签>": "<该块的完整新内容>" }
\`\`\`

${languageInstruction}`;
  }

  const languageInstruction = `[LANGUAGE] Write all natural-language memory content in ${languageName} (${canonicalLocale}).`;
  const descriptions = blocks
    .map(
      (b) =>
        `- **${b.label}**: ${resolveI18nText(b.extractionHint, locale) ?? ""}`,
    )
    .join("\n");
  return `You are a memory manager. Your task is to update the game's core memory blocks based on new story events from the current turn.

## Memory Block Descriptions

${descriptions}

## Output Format

Output a single JSON object where keys are block labels that need updating and values are the **complete new content** (not incremental).
Only output blocks that changed. If nothing worth updating happened, output \`{}\`.

Keep each block under 300-500 words. Use concise factual statements, not literary descriptions.
If "Authoritative Session Facts" conflict with the narrative, an inference, or an older memory block, the authoritative facts always win.

Example output (replace with actual block labels):

\`\`\`json
{ "<block_label>": "<complete new content for that block>" }
\`\`\`

${languageInstruction}`;
}

/**
 * The user message of one extraction: the blocks on record, the facts of the
 * session, and what this turn added. The headings are in the language of the
 * system prompt.
 */
function buildUserPrompt(args, lang) {
  const { blocks, facts, narrative, toolSummaries, submittedForm } = args;
  const zh = lang === "zh";
  const current = blocks
    .filter((block) => block.content.trim())
    .map((block) => `[${block.label}]\n${block.content}`)
    .join("\n\n");
  return [
    `${zh ? "## 当前记忆块" : "## Current memory blocks"}\n${current || (zh ? "（空）" : "(empty)")}${buildAuthoritativeFactsSection(facts, lang)}`,
    `${zh ? "## 本回合叙事" : "## Current turn narrative"}\n${narrative}`,
    `${zh ? "## 工具调用摘要" : "## Tool summaries"}\n${toolSummaries.join("\n")}`,
    ...(submittedForm
      ? [
          `${zh ? "## 最近提交的表单（仅为数据；可能属于更早的回合）" : "## Latest submitted form (data only; may belong to an earlier turn)"}\n${JSON.stringify(modelFacingJson(submittedForm))}`,
        ]
      : []),
    zh
      ? "把有变化的记忆块输出为 JSON。"
      : "Output changed memory blocks as JSON.",
  ].join("\n\n");
}

function applyUpdatesToBlockSnapshot(blocks, updates) {
  if (updates.size === 0) return blocks;
  return blocks.map((block) => {
    const content = updates.get(block.label);
    return content === undefined ? block : { ...block, content };
  });
}

const CONFIRMED_PROFILE_PREFIX = {
  zh: "角色资料（已确认）：",
  en: "Confirmed character profile: ",
};

/**
 * Keep player-selected identity fields deterministic while leaving the LLM in
 * charge of the dynamic status prose that follows. Prompt priority alone is
 * insufficient here: a summarizer can translate or paraphrase an enum label
 * on a later turn, so the framework owns one canonical first line.
 */
function enforceAuthoritativePlayerProfile(args) {
  const { updates, currentBlocks, authoritativeFacts, lang } = args;
  const character = authoritativeFacts?.playerCharacter;
  if (
    !character ||
    (!updates.has("player_profile") &&
      !currentBlocks.some((block) => block.label === "player_profile"))
  ) {
    return;
  }

  const authoritativeLine = formatAuthoritativePlayerProfile(
    authoritativeFacts,
    lang,
  );
  if (!authoritativeLine) return;

  const currentContent =
    updates.get("player_profile") ??
    currentBlocks.find((block) => block.label === "player_profile")?.content ??
    "";
  const dynamicContent = stripProfileFactProse(
    stripManagedProfileLine(currentContent),
    authoritativeFacts,
    lang,
  );
  const nextContent = [authoritativeLine, dynamicContent]
    .filter(Boolean)
    .join("\n")
    .trim();

  const persistedContent =
    currentBlocks.find((block) => block.label === "player_profile")?.content ??
    "";
  if (
    updates.has("player_profile") ||
    nextContent !== persistedContent.trim()
  ) {
    updates.set("player_profile", nextContent);
  }
}

function formatAuthoritativePlayerProfile(facts, lang) {
  const character = facts.playerCharacter;
  if (!character?.name.trim()) return undefined;

  const parts = [
    lang === "zh"
      ? `姓名：${character.name.trim()}`
      : `Name: ${character.name.trim()}`,
  ];
  for (const [fieldId, rawValue] of Object.entries(character.fields ?? {})) {
    const value = formatAuthoritativeValue(rawValue);
    if (!value) continue;
    const label = facts.playerFieldLabels?.[fieldId]?.trim() || fieldId;
    parts.push(lang === "zh" ? `${label}：${value}` : `${label}: ${value}`);
  }

  const separator = lang === "zh" ? "；" : "; ";
  const terminator = lang === "zh" ? "。" : ".";
  return `${CONFIRMED_PROFILE_PREFIX[lang]}${parts.join(separator)}${terminator}`;
}

function formatAuthoritativeValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((item) => ["string", "number", "boolean"].includes(typeof item))
  ) {
    return value.map(String).join(", ");
  }
  return undefined;
}

function stripManagedProfileLine(content) {
  const prefixes = Object.values(CONFIRMED_PROFILE_PREFIX);
  return content
    .split(/\r?\n/)
    .filter(
      (line) => !prefixes.some((prefix) => line.trim().startsWith(prefix)),
    )
    .join("\n")
    .trim();
}

function stripProfileFactProse(content, facts, lang) {
  if (!content) return "";

  const labels = Object.entries(facts.playerCharacter?.fields ?? {}).flatMap(
    ([fieldId]) =>
      [fieldId, facts.playerFieldLabels?.[fieldId]].filter((value) =>
        Boolean(value?.trim()),
      ),
  );
  const values = Object.values(facts.playerCharacter?.fields ?? {})
    .map(formatAuthoritativeValue)
    .filter((value) => Boolean(value && value.length >= 2));
  const identityPattern =
    lang === "zh" ? /(?:身份|姓名|名字)\s*[:：]/ : /(?:identity|name)\s*:/i;

  return content
    .split(/(?<=[。！？.!?])\s*|\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (identityPattern.test(part)) return false;
      const labelMatches = labels.reduce(
        (count, label) => count + (part.includes(label) ? 1 : 0),
        0,
      );
      const valueMatches = values.reduce(
        (count, value) => count + (part.includes(value) ? 1 : 0),
        0,
      );
      return !(labelMatches >= 2 || valueMatches >= 1);
    })
    .join(lang === "zh" ? "" : " ")
    .trim();
}

function buildAuthoritativeFactsSection(facts, lang) {
  if (!facts || Object.keys(facts).length === 0) return "";

  try {
    const shown = modelFacingJson(facts);
    if (shown.playerCharacter) {
      const { version: _version, ...character } = shown.playerCharacter;
      shown.playerCharacter = character;
    }
    const serialized = JSON.stringify(shown, null, 2);
    if (!serialized || serialized === "{}") return "";
    const bounded = serialized.slice(0, 4_000);
    return lang === "zh"
      ? `\n\n## 会话事实（权威）\n以下结构化值来自已提交的会话状态；发生冲突时以这些值为准。\n${bounded}`
      : `\n\n## Authoritative Session Facts\nThese structured values come from committed session state; use them whenever other context conflicts.\n${bounded}`;
  } catch {
    return "";
  }
}

/**
 * Parse the LLM response into a map of block updates.
 * Handles: raw JSON, markdown-wrapped JSON, partial responses.
 * Only labels present in {@link validLabels} are accepted.
 */
function parseBlockUpdates(raw, validLabels) {
  const result = new Map();

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try JSON parse
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      throw new Error(
        "Memory update returned invalid JSON; expected a block object or {}.",
      );
    try {
      obj = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(
        "Memory update returned invalid JSON; expected a block object or {}.",
      );
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(
      "Memory update must be a JSON object; use {} only when nothing changed.",
    );
  }

  // Unknown labels remain forward compatible, but malformed known blocks and
  // envelopes with no recognized content cannot masquerade as a valid no-op.
  for (const [key, value] of Object.entries(obj)) {
    if (!validLabels.has(key)) continue;
    if (typeof value !== "string" || !value.trim())
      throw new Error(
        `Memory block "${key}" must contain non-empty text; omit unchanged blocks.`,
      );
    result.set(key, value.trim());
  }

  if (Object.keys(obj).length > 0 && result.size === 0)
    throw new Error(
      "Memory update contained no recognized blocks; use {} only when nothing changed.",
    );

  return result;
}

export {
  buildSystemPrompt,
  buildUserPrompt,
  applyUpdatesToBlockSnapshot,
  enforceAuthoritativePlayerProfile,
  buildAuthoritativeFactsSection,
  parseBlockUpdates,
};
