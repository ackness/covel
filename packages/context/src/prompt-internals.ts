import {
  requiredAgentWork,
  type EffectiveAgentOutput,
} from "@covel/shared/plugin-runtime";
/**
 * Shared prompt-assembly helpers used by the public context builder and the
 * segment-based prompt assembler.
 *
 * Extracted so the two assemblers share one source of truth for:
 * - template-variable interpolation
 * - inject-block construction
 * - variable-object assembly (the big `variables` record fed to the
 *   interpolator, including `inputs`, `world`, `session`, `player`)
 * - locale → language-name resolution
 *
 * This module is `@internal` — exports are imported by sibling modules only
 * and are not re-exported from `src/index.ts`. Keeping them private to the
 * package prevents plugin code from reaching in and coupling to internals.
 */

import type {
  InputInjectDecl,
  PluginDataInjectDecl,
  RuntimeManifest,
} from "@covel/shared";
import {
  canonicalizeLocale,
  characterLabel,
  instructionLocaleFor,
  localeDisplayName,
  localeRegistry,
  modelFacingJson,
  resolveI18nText,
  isHiddenPluginDataNamespace,
} from "@covel/shared";
import type { PluginDataRecord } from "./session-context-store.js";
import type {
  CharacterSummary,
  ContextBuildParams,
  FrameworkCompletionContract,
} from "./types.js";

/**
 * Resolve a dot-separated path against a nested object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(
  obj: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  const segments = path.split(".");
  let current: unknown = obj;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Character ranges of the template that lie inside a tagged block: a line
 * that opens with `<name>` up to the next `</name>`. A mention of a tag in
 * prose (`` `<name>` ``) does not open a block.
 */
function taggedRanges(template: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const open = /^[ \t]*<([A-Za-z][\w-]*)>/gm;
  let match: RegExpExecArray | null;
  while ((match = open.exec(template)) !== null) {
    const name = match[1] ?? "";
    const start = match.index + match[0].length;
    const end = template.indexOf(`</${name}>`, start);
    if (end < 0) continue;
    ranges.push([start, end]);
    open.lastIndex = end;
  }
  return ranges;
}

/**
 * Replace `{{ path }}` template variables in a prompt string.
 *
 * Supported variable paths:
 * - `{{ inputs.pluginId.runtimeId.fieldName }}` -- other runtime's output field
 * - `{{ session.turnNumber }}` -- the session's turn count
 * - `{{ player.message }}` -- player's current message
 *
 * Unresolved variables are replaced with an empty string.
 *
 * @param template - The prompt template containing `{{ variable }}` placeholders.
 * @param variables - A nested object of variable values to resolve against.
 * @returns The interpolated string with all placeholders replaced.
 *
 * @example
 * ```typescript
 * import { interpolateTemplate } from '@covel/context';
 *
 * const result = interpolateTemplate(
 *   'Hello {{ player.name }}, welcome to {{ world.name }}!',
 *   { player: { name: 'Aria' }, world: { name: 'Cloudmere' } },
 * );
 * // => 'Hello Aria, welcome to Cloudmere!'
 * ```
 * A value inside a tagged block is XML-escaped so data cannot close the block.
 */
export function interpolateTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  const ranges = taggedRanges(template);
  // A scan, not `/\{\{\s*([^}]+?)\s*\}\}/g`: that expression matches the same
  // text, but takes cubic time on `{{` followed by a long run of whitespace,
  // and a prompt body comes from a plugin package. `interpolate` in
  // `@covel/plugin-handlers-utils` has the same scan.
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = template.indexOf("{{", from);
    if (open < 0) break;
    const close = template.indexOf("}", open + 2);
    if (close < 0) break;
    if (close === open + 2 || template[close + 1] !== "}") {
      // Not a variable, and none can start before this `}`.
      from = close + 1;
      continue;
    }
    out += template.slice(copied, open);
    copied = from = close + 2;
    const value = resolvePath(
      variables,
      template.slice(open + 2, close).trim(),
    );
    if (value === undefined || value === null) continue;
    const text = renderTemplateValue(value);
    out += ranges.some(([start, end]) => open >= start && open < end)
      ? escapeXmlContent(text)
      : text;
  }
  return out + template.slice(copied);
}

function renderTemplateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    // A record is written the way `<runtime-inputs>` writes one: compact, and
    // without the bookkeeping a model has no use for (`modelFacingJson`).
    // Indentation only added tokens to every prompt that showed an object.
    return safeStringify(modelFacingJson(value));
  }
  return String(value);
}

/** Extract the tag name from an XML-style tag string like `<narrator-output>`. */
function parseTagName(tag: string): string {
  return tag.replace(/^</, "").replace(/>$/, "");
}

/**
 * Validate that a tag name contains only safe characters (alphanumeric,
 * hyphens, underscores). Throws if the name is empty or contains unsafe chars.
 */
function validateTagName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `[inject] unsafe tag name "${name}" — only alphanumeric, hyphens, and underscores are allowed`,
    );
  }
  return name;
}

/**
 * Long authored text (world lore) keeps its Markdown: a quote line, a comment
 * marker and an ampersand read as written. Only a closing tag of the block
 * that holds the text is rewritten, so the text cannot leave the block.
 */
export function keepInsideBlock(value: string, tagName: string): string {
  const closing = new RegExp(`<(\\s*/\\s*${tagName}\\s*>)`, "gi");
  return value.replace(closing, "&lt;$1");
}

/**
 * Escape XML-special characters in content so injected values cannot break
 * the surrounding XML tag structure.
 */
export function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isPluginDataInject(
  decl: InputInjectDecl,
): decl is PluginDataInjectDecl {
  return decl.kind === "plugin-data";
}

/**
 * Build the inject XML blocks from `manifest.input.inject` declarations.
 *
 * `plugin-data` entries trigger a `store.getPluginDataPromptWindow(sessionId, pluginId,
 * namespace)` call to fetch the runtime's own plugin-data, which is then
 * read through the bounded prompt window and serialised via
 * {@link serializeEntries}. Store errors are not caught — they propagate to
 * the caller so the containing runtime fails cleanly and its error stays on
 * the observability channel (see Phase 0 audit notes in the ticket).
 */
export async function buildInjectBlocksAsync(
  params: ContextBuildParams,
): Promise<string> {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  for (const inject of injects) {
    if (isPluginDataInject(inject)) {
      const block = await resolvePluginDataInject(inject, params);
      if (block) blocks.push(block);
    }
  }
  return blocks.join("\n");
}

/**
 * Resolve a `kind: 'plugin-data'` inject to an XML block.
 *
 * Calls `store.getPluginDataPromptWindow(sessionId, pluginId, namespace)` — pluginId
 * comes from the runtime's own manifest, so cross-plugin reads are
 * structurally impossible through this path. Errors bubble up to the
 * caller (runtime fail → Phase 0 audit guarantees no context pollution).
 */
async function resolvePluginDataInject(
  inject: PluginDataInjectDecl,
  params: ContextBuildParams,
): Promise<string> {
  if (!params.store) {
    throw new Error(
      `[plugin-data inject] store is required for runtime "${params.manifest.name}" ` +
        `but was not provided to buildContext`,
    );
  }

  if (isHiddenPluginDataNamespace(inject.namespace)) {
    throw new Error(
      `[plugin-data inject] runtime "${params.manifest.name}" cannot inject hidden world data ` +
        `("${inject.namespace}") into a prompt; reveal it through a runtime output instead`,
    );
  }

  const { entries, total } = await params.store.getPluginDataPromptWindow(
    params.turnInput.sessionId,
    params.manifest.pluginId,
    inject.namespace,
    inject.maxEntries ?? 50,
  );

  const tagName = validateTagName(parseTagName(inject.as));
  params.onSelfDataRead?.(inject.namespace, entries);

  const zh = instructionLocaleFor(params.turnInput.locale) === "zh";
  if (entries.length === 0) {
    return `<${tagName}>${zh ? "（无）" : "(none)"}</${tagName}>`;
  }

  const format = inject.format ?? "summary";
  const serialized = escapeXmlContent(serializeEntries(entries, format));
  const countLine =
    total <= entries.length
      ? ""
      : zh
        ? `\n[共 ${total} 条记录，显示其中 ${entries.length} 条]`
        : `\n[${total} entries in total, ${entries.length} shown]`;

  return `<${tagName}>\n${serialized}${countLine}\n</${tagName}>`;
}

const SUMMARY_VALUE_CAP = 200;

/**
 * Serialise a truncated plugin-data slice per the declared format.
 *
 * `summary` stays agnostic of the value schema — it stringifies each value
 * to JSON and truncates to 200 chars. This keeps the helper decoupled from
 * any plugin's internal record shape (codex uses `{title, content, tags,
 * rarity}`, character-tracker uses something else, etc).
 */
function serializeEntries(
  entries: readonly PluginDataRecord[],
  format: "summary" | "full" | "ids-only",
): string {
  return entries.map((entry) => formatEntry(entry, format)).join("\n");
}

function formatEntry(
  entry: PluginDataRecord,
  format: "summary" | "full" | "ids-only",
): string {
  if (format === "ids-only") {
    return `- ${entry.key}`;
  }
  // The row's own times and the IDs of rows, turns and the session are not
  // for the model; `updatedAt` also changed the line at every rewrite. A
  // value that repeats the row key as its `id` says it once, on the line.
  const json = safeStringify(
    withoutRowKey(modelFacingJson(entry.value), entry.key),
  );
  if (format === "full") {
    return `- ${entry.key}: ${json}`;
  }
  // summary
  const compact =
    json.length > SUMMARY_VALUE_CAP
      ? `${json.slice(0, SUMMARY_VALUE_CAP)}...`
      : json;
  return `- ${entry.key} | ${compact}`;
}

function withoutRowKey(value: unknown, key: string): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { id?: unknown }).id !== key
  )
    return value;
  const { id: _id, ...rest } = value as Record<string, unknown>;
  return rest;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const NPC_PROFILES_BUDGET = 8000;
const NPC_PROFILE_PART_CAP = 400;

const capped = (text: string) =>
  text.length > NPC_PROFILE_PART_CAP
    ? `${text.slice(0, NPC_PROFILE_PART_CAP)}...`
    : text;

/**
 * `{{ characters.npcs }}`: the description and fields of every character
 * except the one the player acts as, one line each, so a template can give
 * the model the profiles up front instead of a `get-character` round trip per
 * person. Other player characters are listed with their `[player]` tag. Past
 * the budget the rest are listed by name only, to be looked up when needed. A
 * name is followed by `(aka …)` when the character has aliases. No ids: a
 * model looks characters up by name or alias.
 */
export function renderNpcProfiles(
  characters: readonly CharacterSummary[],
  locale?: string,
  currentCharacterId?: string,
): string {
  const lines: string[] = [];
  const unlisted: string[] = [];
  let used = 0;
  for (const character of characters) {
    if (currentCharacterId !== undefined && character.id === currentCharacterId)
      continue;
    const parts = [`- ${characterLabel(character)} [${character.type}]`];
    if (character.description) parts.push(capped(character.description));
    if (character.fields && Object.keys(character.fields).length > 0)
      parts.push(capped(safeStringify(modelFacingJson(character.fields))));
    const line = parts.join(" | ");
    if (unlisted.length > 0 || used + line.length > NPC_PROFILES_BUDGET) {
      unlisted.push(character.name);
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (unlisted.length > 0)
    lines.push(
      instructionLocaleFor(locale) === "zh"
        ? `- （未列出档案：${unlisted.join("、")}）`
        : `- (profiles not shown: ${unlisted.join(", ")})`,
    );
  return lines.join("\n");
}

/**
 * Assemble the full variables object consumed by `interpolateTemplate`.
 *
 * Mirrors the logic previously inlined in `buildContext`. The public sync and
 * async context builders share this variable surface so plugin templates see
 * the same data regardless of whether plugin-data injects require async IO.
 */
export function assemblePromptVariables(
  params: ContextBuildParams,
): Record<string, unknown> {
  const { turnInput, completedResults } = params;
  const sessionMeta = params.sessionContext?.sessionMeta ?? params.sessionMeta;
  const world = params.sessionContext?.world ?? {};

  // Build the `inputs` lookup map: pluginId → runtimeId → output.
  const inputsMap: Record<
    string,
    Record<string, Record<string, unknown>>
  > = Object.create(null);
  for (const [key, result] of completedResults) {
    if (!result.output) continue;
    const slashIdx = key.indexOf("/");
    // Single-runtime: name = "narrator" → pluginId = runtimeId = "narrator"
    // Multi-runtime:  name = "world-init/schema-gen" → pluginId = "world-init", runtimeId = "schema-gen"
    const pluginId = slashIdx >= 0 ? key.slice(0, slashIdx) : key;
    const runtimeId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
    const byRuntime: Record<string, Record<string, unknown>> = (inputsMap[
      pluginId
    ] ??= Object.create(null));
    byRuntime[runtimeId] = result.output;
  }

  // The character the player acts as: the primary seat's current character.
  const currentCharacterId = sessionMeta?.currentCharacterId;
  const playerChar =
    currentCharacterId === undefined
      ? null
      : (sessionMeta?.characters?.find((c) => c.id === currentCharacterId) ??
        null);

  // The latest form submission renders as JSON, and as nothing when the form
  // had no values.
  const lastFormValuesRaw = sessionMeta?.lastFormValues;
  const lastFormValuesStr =
    lastFormValuesRaw && Object.keys(lastFormValuesRaw).length > 0
      ? renderTemplateValue(lastFormValuesRaw)
      : "";

  return {
    inputs: inputsMap,
    world,
    // A turn is named by its number. The session ID is bookkeeping: a model
    // has no use for it, and it differs between two runs of one session.
    session: {
      turnNumber: sessionMeta?.turnNumber ?? 0,
    },
    characters: {
      npcs: renderNpcProfiles(
        sessionMeta?.characters ?? [],
        turnInput.locale,
        currentCharacterId,
      ),
    },
    player: {
      message: turnInput.playerMessage,
      character: playerChar,
      lastFormValues: lastFormValuesStr,
      lastFormValuesRaw,
    },
    // Player-authored plugin settings, merged with manifest.userSettings[].default.
    // Undefined when the manifest declares none — dot-path lookups then return
    // empty strings, matching the behaviour of any other missing variable.
    userSettings: params.userSettings ?? {},
  };
}

/**
 * Build the current-turn user message passed to the LLM.
 *
 * Empty player input commonly happens on framework-driven turns such as
 * `start_session`. In that case we supply a compact execution cue so models
 * stay inside the runtime task instead of drifting into assistant small talk.
 */
export function buildCurrentTurnUserMessage(
  turnInput: Pick<
    ContextBuildParams["turnInput"],
    "playerMessage" | "locale" | "manualTrigger"
  >,
): string {
  if (turnInput.playerMessage.trim().length > 0) {
    return turnInput.playerMessage;
  }

  const locale = turnInput.locale ?? "";
  if (turnInput.manualTrigger) {
    const runtimeId = turnInput.manualTrigger.runtimeId;
    if (instructionLocaleFor(locale) === "zh") {
      return `执行当前手动触发的 runtime：${runtimeId}。严格遵循系统提示中的输出格式，产出该 runtime 的结果。`;
    }

    return `Execute the current manually triggered runtime: ${runtimeId}. Follow the output format in the system prompt exactly and produce this runtime's result.`;
  }

  if (instructionLocaleFor(locale) === "zh") {
    return "开始当前游戏回合，并按照系统设定直接给出游戏内结果。";
  }

  return "Begin the current game turn and produce the in-game result defined by the system instructions.";
}

/**
 * Closing user message after the story text of the running execution.
 *
 * A runtime that runs after the story must treat the end of that text as the
 * present. The cue says so, and it keeps the request from ending on an
 * assistant message, which a provider can take as text to continue.
 */
export function buildExecutionStoryCue(locale: string | undefined): string {
  if (instructionLocaleFor(locale ?? "") === "zh") {
    return "上面这段正文是本回合在玩家消息之后写出的，剧情现在停在它的结尾。请按系统指令完成本 runtime 的任务。";
  }

  return "The story text above was written in this turn, after the player's message. The story now stands at its end. Do this runtime's task as the system instructions define.";
}

/** The same submission contract drives prompt assembly and tool advertisement. */
export function resolveFrameworkCompletion(
  manifest: Pick<RuntimeManifest, "requireToolUse" | "completeAfterTools">,
  output?: EffectiveAgentOutput,
): FrameworkCompletionContract {
  return {
    completion: "submit-output",
    requiredWork: output?.requiredWork ?? requiredAgentWork(manifest),
  };
}

function completionInstruction(
  contract: FrameworkCompletionContract | undefined,
  isZh: boolean,
): readonly string[] {
  const required = contract?.requiredWork;
  const names = required?.toolNames.map((name) => `\`${name}\``).join(", ");
  const lines = isZh
    ? [
        "[COMPLETION] 完成必需的业务工具工作后，单独调用 `submit-output` 提交最终结果。参数必须符合该工具的 schema；回复正文不是输出通道。若提交被拒绝，修正报告的问题并再次调用。提交成功结束本次运行，但不代表更改已经保存。",
        "[COMPLETION] 没有业务输出且 schema 允许时，提交 `{}`。没有声明输出 schema 的 system agent 可以这样表达无变化。提交工具不产生领域写入，也不代替必需的业务工作。",
      ]
    : [
        "[COMPLETION] After required business tool work, call `submit-output` alone with the final result. Arguments must match the tool schema; reply content is not an output channel. If rejected, correct the reported problems and submit again. Successful submission ends this run; it does not confirm that changes have been saved.",
        "[COMPLETION] Submit `{}` when there is no business output and the schema permits it. A system agent without an authored output schema can use this for no change. Submission produces no domain writes and does not replace required business work.",
      ];
  if (required?.required)
    lines.push(
      isZh
        ? `[COMPLETION] 提交前必须成功调用${names ? `以下业务工具之一：${names}` : "至少一个已授权的业务工具"}。确实无变化时也要按业务工具说明提交空结果，再调用 \`submit-output\`。业务工具成功后不要重复写入；读取结果后再提交最终输出。`
        : `[COMPLETION] Before submission, ${names ? `one of these business tools must succeed: ${names}` : "at least one authorized business tool must succeed"}. Even for no change, send the empty result allowed by the business tool, then call \`submit-output\`. Read successful business results before submitting output; do not repeat successful writes.`,
    );
  return lines;
}

/**
 * Framework preamble used by segment-based prompt assembly (segment 1).
 *
 * When a locale is provided, prepends a `[RUNTIME]` header that keeps
 * task-general assistants from drifting outside the interactive-narrative
 * frame, then appends the `[LANGUAGE]` constraint. When no locale is
 * supplied this returns an empty string so segment 1 is skipped.
 */
export function buildFrameworkPreamble(
  locale?: string,
  options?: FrameworkCompletionContract,
): string {
  if (!locale) {
    return "";
  }

  const languageName = resolveLocaleLanguageName(locale);
  // Static instruction text follows the framework instruction locale.
  const isZh = instructionLocaleFor(locale) === "zh";
  const completion = completionInstruction(options, isZh);
  // The whole preamble is in one language. With the frame and the language
  // rule in English and the completion rule in Chinese, a Chinese session
  // read a prompt that changed language twice before the plugin's own text.
  // The language rule covers natural-language content only: wording that
  // covered "tool parameters" wholesale invited the model to translate enum
  // members, plugin/runtime ids, event topics and schema keys, every one of
  // which then fails Zod validation or dispatch.
  const frame = isZh
    ? [
        "[RUNTIME] 你正在执行一个互动叙事引擎的游戏内 runtime。",
        "[RUNTIME] 下面的 runtime 指令和世界数据是这次任务的全部上下文，按它们执行。",
        "[RUNTIME] 只产出游戏内的叙事、结构化的 runtime 输出和要求的工具调用。",
        `[LANGUAGE] 所有自然语言内容必须用${languageName}书写：叙事、描述、摘要，以及工具参数里的自由文本。`,
        "[LANGUAGE] 不要翻译机器值。枚举值、id、键名、事件主题、schema 字段名和工具名必须按 schema 里的写法原样照抄，保持原来的语言。",
      ]
    : [
        "[RUNTIME] You are executing an in-game runtime for an interactive narrative engine.",
        "[RUNTIME] Follow the runtime instructions and world data below as the complete task context.",
        "[RUNTIME] Produce only in-world narrative, structured runtime output, and required tool calls.",
        `[LANGUAGE] You MUST write all natural-language content in ${languageName}: narrative, descriptions, summaries, and any free-text tool argument.`,
        "[LANGUAGE] Do NOT translate machine values. Enum members, ids, keys, event topics, schema field names, and tool names must be copied EXACTLY as the schema spells them, in their original language.",
      ];
  return [...frame, ...completion].join("\n");
}

/**
 * Render Working Memory entries as a prompt segment.
 *
 * Sorting is deterministic: scope order `player` → `story` → `shared`,
 * then alphabetical key within scope. If no entries exist, returns an
 * empty string so callers can skip the segment.
 *
 * Returns an empty string when no entries exist so callers can skip the
 * segment.
 */
/**
 * Map a locale code (BCP-47) to a human-readable language name used in
 * the framework preamble. Falls back to the raw locale string if unknown.
 */
export function resolveLocaleLanguageName(locale: string): string {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) return locale;

  const definition = localeRegistry.resolve(canonical);
  if (definition) {
    return resolveI18nText(definition.label, canonical) ?? definition.code;
  }
  return localeDisplayName(canonical);
}
