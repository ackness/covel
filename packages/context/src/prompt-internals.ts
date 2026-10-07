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
  RuntimeInjectDecl,
  RuntimeManifest,
} from "@covel/shared";
import {
  canonicalizeLocale,
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
 * Replace `{{ path }}` template variables in a prompt string.
 * Unresolved variables are replaced with an empty string.
 */
export function interpolateTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(variables, path.trim());
    if (value === undefined || value === null) {
      return "";
    }
    return renderTemplateValue(value);
  });
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
 * Escape XML-special characters in content so injected values cannot break
 * the surrounding XML tag structure.
 */
export function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Check whether a declaration is the runtime-output variant.
 */
function isRuntimeInject(decl: InputInjectDecl): decl is RuntimeInjectDecl {
  return decl.kind === "runtime";
}

function isPluginDataInject(
  decl: InputInjectDecl,
): decl is PluginDataInjectDecl {
  return (decl as { kind?: string }).kind === "plugin-data";
}

/**
 * Resolve a single runtime-output inject to its XML block, or null when
 * the upstream runtime has no output or the named field is absent.
 */
function resolveRuntimeInject(
  inject: RuntimeInjectDecl,
  params: ContextBuildParams,
): string | null {
  const result = params.completedResults.get(inject.from);
  if (!result?.output) return null;

  const value = result.output[inject.field];
  if (value === undefined || value === null) return null;

  const tagName = validateTagName(parseTagName(inject.as));
  return `<${tagName}>${escapeXmlContent(renderTemplateValue(value))}</${tagName}>`;
}

/**
 * Build the inject XML blocks from `manifest.input.inject` declarations.
 *
 * Synchronous path — only supports `kind: 'runtime'` entries. Any
 * `kind: 'plugin-data'` entries are silently skipped here; use
 * {@link buildInjectBlocksAsync} when the manifest declares plugin-data
 * injects. Callers decide which path to take by inspecting
 * `manifest.input?.inject` before building the context.
 */
export function buildInjectBlocks(params: ContextBuildParams): string {
  const injects = params.manifest.input?.inject;
  if (!injects || injects.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  for (const inject of injects) {
    if (!isRuntimeInject(inject)) continue;
    const block = resolveRuntimeInject(inject, params);
    if (block) blocks.push(block);
  }
  return blocks.join("\n");
}

/**
 * Async variant of {@link buildInjectBlocks} — handles both `kind: 'runtime'`
 * and `kind: 'plugin-data'` declarations.
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
    if (isRuntimeInject(inject)) {
      const block = resolveRuntimeInject(inject, params);
      if (block) blocks.push(block);
      continue;
    }

    if (isPluginDataInject(inject)) {
      const block = await resolvePluginDataInject(inject, params);
      if (block) blocks.push(block);
      continue;
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
 * `{{ characters.npcs }}`: every non-player character's description and
 * fields, one line each, so a template can give the model the profiles up
 * front instead of a `get-character` round trip per person. Past the budget
 * the rest are listed by name only, to be looked up when needed. No ids: a
 * model looks characters up by name.
 */
export function renderNpcProfiles(
  characters: readonly CharacterSummary[],
  locale?: string,
): string {
  const lines: string[] = [];
  const unlisted: string[] = [];
  let used = 0;
  for (const character of characters) {
    if (character.type === "player") continue;
    const parts = [`- ${character.name} [${character.type}]`];
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
    if (!inputsMap[pluginId]) {
      inputsMap[pluginId] = Object.create(null);
    }
    inputsMap[pluginId][runtimeId] = result.output;
  }

  const playerChar =
    sessionMeta?.characters?.find((c) => c.type === "player") ?? null;

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
      npcs: renderNpcProfiles(sessionMeta?.characters ?? [], turnInput.locale),
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

/**
 * How a runtime finishes, from the manifest fields the agent loop builds its
 * policy from (`requireToolUse`, `completeAfterTools`, the output schema).
 *
 * The `[COMPLETION]` instruction and the tools the runtime is offered both
 * come from this one answer. Derived apart, they disagreed: a runtime that
 * must call a tool was offered `runtime-done` and told to end a quiet turn
 * with it, a call the loop answers with a correction and one more model call.
 */
export function resolveFrameworkCompletion(
  manifest: Pick<
    RuntimeManifest,
    "output" | "outputKind" | "requireToolUse" | "completeAfterTools"
  >,
): FrameworkCompletionContract {
  if (manifest.outputKind === "story") return { completion: "story" };
  const completingTools = manifest.completeAfterTools ?? [];
  // The loop ends such a run when one of these tools succeeds, and takes the
  // tool's result as the output of a runtime that declares a schema.
  if (manifest.requireToolUse === true && completingTools.length > 0)
    return { completion: "completing-tool", completingTools };
  if (manifest.output?.schema) return { completion: "structured-output" };
  return {
    completion: "runtime-done",
    requireToolUse: manifest.requireToolUse === true,
  };
}

/** The `[COMPLETION]` lines of the preamble for one way of finishing. */
function completionInstruction(
  contract: FrameworkCompletionContract | undefined,
  isZh: boolean,
): readonly string[] {
  const mode = contract?.completion ?? "runtime-done";
  if (mode === "story") {
    return isZh
      ? [
          "[COMPLETION] 本 runtime 的结果是你回复里的故事正文。工具按下面的指令使用；最后一次工具结果之后，把正文作为回复写出来。只有工具调用、没有正文的回复不算完成。",
        ]
      : [
          "[COMPLETION] The result of this runtime is the story text of your reply. Use tools as the instructions below say; after the last tool result, write the story as your reply. A reply with a tool call and no story text does not finish this runtime.",
        ];
  }
  if (mode === "completing-tool") {
    // The run ends with the tool, and a quiet turn is recorded through it
    // too: this runtime is not given `runtime-done`, which records nothing.
    const names = (contract?.completingTools ?? []).map(
      (name) => `\`${name}\``,
    );
    if (isZh) {
      const tool =
        names.length === 0
          ? "完成工具"
          : names.length === 1
            ? ` ${names[0]} `
            : ` ${names.join("、")} 中的任意一个`;
      return [
        `[COMPLETION] 本 runtime 在成功调用${tool}后结束：调用成功后框架会自动结束本次运行。之后不要输出额外终止文本，也不要调用 \`runtime-done\`——本 runtime 没有该工具。`,
        "[COMPLETION] 本回合确实无变化时，也通过同一个工具记录：按工具说明提交空结果。",
      ];
    }
    const tool =
      names.length === 0
        ? "its completing tool"
        : names.length === 1
          ? names[0]
          : `one of ${names.join(", ")}`;
    return [
      `[COMPLETION] This runtime ends when a call to ${tool} succeeds: the framework then finishes the run. Do not emit terminator text after it, and do not call \`runtime-done\` — this runtime does not have that tool.`,
      "[COMPLETION] A turn in which nothing changed is recorded through the same tool: submit the empty result its description allows.",
    ];
  }
  if (mode === "structured-output") {
    return isZh
      ? [
          "[COMPLETION] 本 runtime 以**结构化 JSON 输出**结束：完成所有业务工具调用后，直接返回符合 schema 的 JSON。不要调用 `runtime-done`——本 runtime 没有该工具。",
        ]
      : [
          "[COMPLETION] This runtime finishes by emitting its **structured JSON output**: once all tool work is done, return the JSON matching the declared schema. Do NOT call `runtime-done` — this runtime does not have that tool.",
        ];
  }
  // A runtime that must record its result is not told that `runtime-done`
  // alone ends a quiet turn: the loop rejects that call.
  if (isZh) {
    return [
      "[COMPLETION] 本 runtime 完成所有业务工具调用后，必须立即调用 `runtime-done` 工具结束。不要输出额外终止文本——调用 `runtime-done` 就是结束信号。",
      contract?.requireToolUse
        ? "[COMPLETION] 本 runtime 必须用声明的业务工具提交结果：只调用 `runtime-done` 不会记录任何内容。本回合确实无变化时，也要按工具说明提交空结果，再调用 `runtime-done`。不要反复调用同一个业务工具。"
        : "[COMPLETION] 如果判断本回合无需任何工具调用，直接调用 `runtime-done` 结束（优先）或返回空字符串。不要反复调用同一个业务工具。",
    ];
  }
  return [
    "[COMPLETION] When you have finished all tool work for this runtime, call the `runtime-done` tool IMMEDIATELY. Do not emit terminator text — calling `runtime-done` is the end signal.",
    contract?.requireToolUse
      ? "[COMPLETION] This runtime must record its result with a declared business tool: `runtime-done` alone records nothing. If nothing changed this turn, submit the empty result the tool's description allows, then call `runtime-done`. Do not repeatedly call the same business tool."
      : "[COMPLETION] If no tool call is needed this turn, just call `runtime-done` to finish (preferred), or return an empty string. Do not repeatedly call the same business tool.",
  ];
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
  // Framework completion contract — see packages/tools/src/builtin/runtime-done.ts
  // and the tool_calls early-exit branch in turn-executor.ts. Without this
  // preamble, agent runtimes waste a round-trip on a terminator message after
  // every successful tool call. Emitted in the session's instruction language
  // (English, or Chinese for a Chinese session) rather than every locale at once.
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
