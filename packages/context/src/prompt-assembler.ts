import { selectPromptSegments } from "./extension-segments.js";
/**
 * Segment-based Prompt Assembler.
 *
 * Implements the 10-segment assembly model:
 *
 * ```
 * [1 Framework Preamble]        ← session-stable header (locale, rules)
 * [2 Working Memory]            ← session-stable slow-vary
 * [3 Plugin Instructions]       ← PLUGIN.md body, per-plugin stable
 * [4 WorldInfo: before-plugin]  ← keyword-triggered
 * [5 Session injects]           ← the event directory
 * [6 WorldInfo: after-plugin]   ← keyword-triggered
 * ---- messages ----
 * [7 history (after pruning)]   ← dynamic (handled as messages)
 * [8 Turn context]              ← this turn's data and turn-volatile segments
 *   current player message, then the story text this execution already
 *   produced and its closing cue (runtimes that run after the story)
 * [9 WorldInfo: at-depth:N]     ← placed before Nth-from-last message (depthContributions)
 * [10 Post-History Instructions]← director-grade high-weight
 * ```
 *
 * Everything that changes with the turn comes after the history. A provider
 * serves a request from its cache only as far as it matches an earlier one
 * from the first byte, so a system prompt that carried this turn's inputs put
 * the whole history out of reach.
 *
 * Empty segments are skipped during final concatenation so the output stays
 * clean. The returned `AssembledContext.messages` array contains history,
 * the current user message, and any depth/post-history prompt contributions.
 */

import { DEFAULT_PROTECT_LAST_USER_TURNS, applyBudget } from "./budget.js";
import {
  assemblePromptVariables,
  buildCurrentTurnUserMessage,
  buildExecutionStoryCue,
  buildFrameworkPreamble,
  buildInjectBlocks,
  buildInjectBlocksAsync,
  escapeXmlContent,
  keepInsideBlock,
  interpolateTemplate,
  resolveFrameworkCompletion,
} from "./prompt-internals.js";
import { serializeSystemPrompt } from "./prompt-serialization.js";
import { fitWorldLore } from "./world-lore.js";
import {
  activeContributions,
  collectDepthContributions,
  renderSystemLoreContributions,
} from "./contribution-aggregator.js";
import {
  buildExecutionStoryMessages,
  buildRecentPicturesMessage,
  buildMessageHistoryWithSummaries,
  insertDepthContributions,
  type RenderedDepthContribution,
} from "./message-insertion.js";
import {
  instructionLocaleFor,
  modelFacingJson,
  PROMPT_CACHE_BREAKPOINT_MARKER,
} from "@covel/shared";
import type { InputSlot, InputSource } from "@covel/shared";
import type {
  AssembledContext,
  ContextBuildParams,
  FrameworkCompletionContract,
  LLMMessage,
} from "./types.js";

/**
 * Structured view of the system-prompt segments.
 *
 * Segments 1, 3, 5 carry the pre-history system prompt body; segments 4 and 6
 * carry lorebook `before-plugin` / `after-plugin` world info. Segments 9 and
 * 10 render as extra messages (not part of the system prompt string), as do
 * the at-depth (segment 8) contributions, which are inserted into the message
 * stack via {@link depthContributions} rather than the system prompt string.
 */
interface PromptSegments {
  /** Segment 1 — framework preamble (session-stable header). */
  readonly stableExtensions?: string;
  readonly turnExtensions?: string;
  readonly preHistoryExtensions?: readonly LLMMessage[];
  readonly frameworkPreamble: string;
  /** Segment 3 — interpolated PLUGIN.md body (with template interpolation). */
  readonly pluginInstructions: string;
  /** Segment 4 — lorebook `before-plugin` position. */
  readonly worldInfoBeforePlugin: string;
  /**
   * Segment 5 — blocks that hold from turn to turn: the event directory, and
   * the activation of a staged run, which is the same every turn.
   */
  readonly sessionInjects: string;
  /**
   * Segment 8 — data of this turn: the runtime's own data, its inputs and
   * exports, and the activation of an event or manual run, which carries a
   * payload (XML-wrapped).
   */
  readonly turnData: string;
  /** Segment 8 — `position: "system"` extension segments that change with the turn. */
  readonly turnContextExtensions: string;
  /** Segment 6 — lorebook `after-plugin` position. */
  readonly worldInfoAfterPlugin: string;
  /**
   * Segment 10 — Post-history instructions aggregated across active
   * plugins. One message per unique role, appended at the
   * very end of the message array.
   */
  readonly postHistoryInstructions: readonly LLMMessage[];
  readonly depthContributions: readonly RenderedDepthContribution[];
}

/**
 * Build the default segment-1 framework preamble from the turn locale.
 *
 * Kept intentionally short — roughly two sentences — so it is cheap to
 * cache as the stable prefix of a prompt. When no locale is supplied the
 * preamble is empty and segment 1 is skipped during concatenation.
 *
 * Callers may override this entirely via `ContextBuildParams.frameworkPreamble`.
 */
function defaultFrameworkPreamble(
  locale: string | undefined,
  completion: FrameworkCompletionContract,
): string {
  return buildFrameworkPreamble(locale, completion);
}

/**
 * Renders the session's event directory into a segment-5 XML block for
 * runtimes that opt in via `manifest.advertiseEvents: true`. Only the
 * emitting runtime pays for this — consumer-only runtimes never see it.
 *
 * The closing line is an instruction, so it follows the instruction language
 * like `buildFrameworkPreamble`. `eventCatalogText` is already resolved to the
 * session locale by the event-directory service.
 */
function buildAvailableEventsBlock(params: ContextBuildParams): string {
  if (params.manifest.advertiseEvents !== true) return "";
  const catalog = params.eventCatalogText;
  if (!catalog) return "";
  const instruction =
    instructionLocaleFor(params.turnInput.locale) === "zh"
      ? "叙事里发生了已声明的领域事件时，调用 emit-event 工具——每次调用一个 topic；工具调用不属于正文。"
      : "When a declared domain event occurs in your narration, call the emit-event tool — one topic per call; tool calls are not part of the prose.";
  return `<available-events>\n${escapeXmlContent(catalog)}\n\n${instruction}\n</available-events>`;
}

/**
 * Reserved `<runtime-activation>` block (docs 02 §3.3): the canonical
 * `{ source, detached, payload }` JSON, identical to what a function handler
 * reads from `ctx.activation`. Framework-built inside segment 5, so a plugin
 * template can neither override nor omit it. Absent when no activation was
 * threaded (legacy callers) — keeps existing prompts byte-identical.
 */
function buildRuntimeActivationBlock(params: ContextBuildParams): string {
  const activation = params.activation;
  if (!activation) return "";
  const json = JSON.stringify({
    source: activation.source,
    detached: activation.detached,
    payload: activation.payload,
  });
  return `<runtime-activation>\n${escapeXmlContent(json)}\n</runtime-activation>`;
}

/**
 * Slots as the model sees them: the producing plugin and runtime stay as
 * provenance, but the result id, a UUID only tools and the kernel use (they
 * read it from `ctx.inputSlots`), is left out of the prompt, and so is the
 * bookkeeping inside each value (`modelFacingJson`).
 */
function modelFacingSlots(
  slots: Readonly<Record<string, InputSlot>>,
  inConversation?: {
    readonly texts: ReadonlySet<string>;
    readonly note: string;
  },
): Record<string, unknown> {
  const source = ({ pluginId, runtimeId }: InputSource) => ({
    pluginId,
    runtimeId,
  });
  return Object.fromEntries(
    Object.entries(slots).map(([name, slot]) => [
      name,
      slot.cardinality === "one"
        ? {
            ...slot,
            value:
              typeof slot.value === "string" &&
              inConversation?.texts.has(slot.value)
                ? inConversation.note
                : modelFacingJson(slot.value),
            source: source(slot.source),
          }
        : {
            ...slot,
            items: slot.items.map((item) => ({
              ...item,
              value: modelFacingJson(item.value),
              source: source(item.source),
            })),
          },
    ]),
  );
}

/**
 * Reserved `<runtime-inputs>` block (docs 02 §3.2): the provenance-wrapped
 * `inputs.<name>` slots as JSON, the shape a function handler reads from
 * `ctx.inputs` minus result ids. Absent when no bindings resolved.
 */
function buildInputsBindingBlock(params: ContextBuildParams): string {
  const slots = params.inputSlots;
  if (!slots || Object.keys(slots).length === 0) return "";
  return `<runtime-inputs>\n${escapeXmlContent(JSON.stringify(modelFacingSlots(slots, executionStoryInConversation(params))))}\n</runtime-inputs>`;
}

/**
 * Story text of the running execution that the conversation already carries
 * as an assistant message (see `buildExecutionStoryMessages`). An input whose
 * whole value is that text would send it a second time, so the slot names the
 * message instead. A retry after the commit has no execution story: the text
 * is then in the history and the slot keeps its value.
 */
function executionStoryInConversation(
  params: ContextBuildParams,
): { readonly texts: ReadonlySet<string>; readonly note: string } | undefined {
  const texts = new Set(
    (params.executionStory ?? [])
      .filter((record) => record.content.length > 0)
      .map((record) => record.content),
  );
  if (texts.size === 0) return undefined;
  return {
    texts,
    note:
      instructionLocaleFor(params.turnInput.locale) === "zh"
        ? "（本回合的故事正文：见下方对话里最后一段故事正文，这里不重复）"
        : "(this turn's story text: the last story reply in the conversation below; not repeated here)",
  };
}

/**
 * Reserved `<runtime-exports>` block (docs 02 §3.4.3): the provenance-wrapped
 * cross-execution `recordAs` export slots as JSON, the shape a function
 * handler reads from `ctx.exports` minus result ids. Absent when no export
 * binding resolved.
 */
function buildExportsBindingBlock(params: ContextBuildParams): string {
  const slots = params.exportSlots;
  if (!slots || Object.keys(slots).length === 0) return "";
  return `<runtime-exports>\n${escapeXmlContent(JSON.stringify(modelFacingSlots(slots)))}\n</runtime-exports>`;
}

/**
 * Build the 10 prompt segments for a single runtime context.
 *
 * Internal helper — used by the exported segmented context builder so tests
 * stay focused on the public shape.
 */
function buildPromptSegments(params: ContextBuildParams): PromptSegments {
  return buildPromptSegmentsCommon(params, buildInjectBlocks(params));
}

/**
 * Async variant — same as {@link buildPromptSegments} but resolves
 * `kind: 'plugin-data'` inject declarations via the injected store.
 */
async function buildPromptSegmentsAsync(
  params: ContextBuildParams,
): Promise<PromptSegments> {
  const rawInjects = await buildInjectBlocksAsync(params);
  return buildPromptSegmentsCommon(params, rawInjects);
}

/**
 * Shared segment assembly given a pre-resolved inject-block string. Split
 * out so the sync and async paths share every other segment unchanged.
 */
function buildPromptSegmentsCommon(
  params: ContextBuildParams,
  rawInjects: string,
): PromptSegments {
  const variables = assemblePromptVariables(params);

  const pluginInstructions = interpolateTemplate(
    params.promptTemplate,
    variables,
  );
  const contributions = activeContributions(params);
  const worldInfoBeforePlugin = renderSystemLoreContributions(
    contributions,
    "before_plugin",
  );
  const worldInfoAfterPlugin = renderSystemLoreContributions(
    contributions,
    "after_plugin",
  );
  // Inject blocks are NOT re-interpolated. Their content is already
  // XML-escaped upstream (see resolveRuntimeInject / resolvePluginDataInject),
  // but `escapeXmlContent` does not touch `{}` — so a second
  // `interpolateTemplate` pass expanded any `{{ ... }}` sequence that appeared
  // inside model-authored or player-authored DATA, and the expansion result
  // was inserted raw, bypassing escaping entirely. The template is interpreted
  // exactly once, over the plugin's own PLUGIN.md body; injected data is data.
  const activation = buildRuntimeActivationBlock(params);
  const staged = params.activation?.source === "stage";
  const sessionInjects = [
    buildAvailableEventsBlock(params),
    staged ? activation : "",
  ]
    .filter(Boolean)
    .join("\n");
  const turnData = [
    rawInjects,
    buildInputsBindingBlock(params),
    buildExportsBindingBlock(params),
    staged ? "" : activation,
  ]
    .filter(Boolean)
    .join("\n");

  // The completion instruction must match how the runtime finishes. The loop
  // decides which tools the runtime is offered from the same answer, so a
  // runtime is told to call `runtime-done` only when it is given that tool.
  const frameworkPreamble =
    params.frameworkPreamble ??
    defaultFrameworkPreamble(
      params.turnInput.locale,
      resolveFrameworkCompletion(params.manifest),
    );

  const extensionSegments = selectPromptSegments(
    params.promptSegments,
    params.manifest,
  );
  const systemSegments = extensionSegments.filter(
    (segment) =>
      segment.position === "system" ||
      (segment.position === "pre-history" &&
        (segment.role ?? "system") === "system"),
  );
  const preHistoryExtensions = extensionSegments
    .filter(
      (segment) =>
        segment.position === "pre-history" &&
        segment.role !== undefined &&
        segment.role !== "system",
    )
    .map((segment) => ({
      role: segment.role ?? "system",
      content: segment.content,
    }));
  const extensionDepth = extensionSegments
    .filter((segment) => typeof segment.position === "object")
    .map((segment) => ({
      depth: typeof segment.position === "object" ? segment.position.depth : 0,
      role: segment.role ?? "system",
      content: segment.content,
      order: segment.order ?? 0,
    }));
  // Volatility decides where a system segment goes (see
  // docs/reference/extension-points.md). A `position: "system"` segment that
  // changes with the turn joins the turn context after the history, so the
  // system prompt holds from turn to turn. One that asked for `pre-history`
  // stays ahead of the history, at the end of the system prompt. Other
  // positions (non-system pre-history, post-history, depth) ignore volatility.
  const turnSegments = systemSegments.filter(
    (segment) => segment.volatility === "turn",
  );
  const lore =
    params.manifest.outputKind === "story"
      ? params.sessionContext?.world.lore
      : undefined;
  const worldLore = lore?.trim()
    ? `<world-lore>\n${keepInsideBlock(fitWorldLore(lore).text, "world-lore")}\n</world-lore>`
    : "";
  return {
    stableExtensions: [
      worldLore,
      ...systemSegments
        .filter((segment) => segment.volatility !== "turn")
        .map((segment) => segment.content),
    ]
      .filter(Boolean)
      .join("\n\n"),
    turnExtensions: turnSegments
      .filter((segment) => segment.position === "pre-history")
      .map((segment) => segment.content)
      .join("\n\n"),
    turnContextExtensions: turnSegments
      .filter((segment) => segment.position === "system")
      .map((segment) => segment.content)
      .join("\n\n"),
    preHistoryExtensions,
    frameworkPreamble,
    pluginInstructions,
    worldInfoBeforePlugin,
    sessionInjects,
    turnData,
    worldInfoAfterPlugin,
    postHistoryInstructions: extensionSegments
      .filter((segment) => segment.position === "post-history")
      .map((segment) => ({
        role: segment.role ?? "system",
        content: segment.content,
      })),
    depthContributions: [
      ...collectDepthContributions(contributions),
      ...extensionDepth,
    ],
  };
}

/**
 * Build the assembled runtime context. Same return shape as
 * {@link buildContext}.
 *
 * Assembles the system prompt as 10 named segments (see {@link PromptSegments}),
 * then joins segments 1–6 with `\n\n` as the final `systemPrompt`. The
 * `messages` array contains history + current user message, with any
 * depth-positioned notes and post-history instructions applied afterward.
 *
 * When the caller supplies both `estimator` and `contextBudget`, the pruning
 * pass runs before returning.
 *
 * @param params - Same shape as `buildContext` with an optional
 *   `frameworkPreamble` override for segment 1.
 */
export function buildSegmentedContext(
  params: ContextBuildParams,
): AssembledContext {
  const segments = buildPromptSegments(params);
  return finalizeSegmentedContext(params, segments);
}

/**
 * Async assembly path — identical to {@link buildSegmentedContext} but uses
 * {@link buildPromptSegmentsAsync} so `kind: 'plugin-data'` injects can
 * await the store.
 */
export async function buildSegmentedContextAsync(
  params: ContextBuildParams,
): Promise<AssembledContext> {
  const segments = await buildPromptSegmentsAsync(params);
  return finalizeSegmentedContext(params, segments);
}

/**
 * Shared finalisation — message history, author's notes, post-history
 * instructions, and budget pruning. Split out so the sync and async
 * paths share every post-segment step.
 */
function finalizeSegmentedContext(
  params: ContextBuildParams,
  segments: PromptSegments,
): AssembledContext {
  const systemPrompt = serializeSystemPrompt(segments, true);
  // Serialization emits segment 1 first, followed by its cache marker.
  const frameworkHead = segments.frameworkPreamble
    ? segments.frameworkPreamble + PROMPT_CACHE_BREAKPOINT_MARKER
    : "";

  // Segment 7: history with optional compaction substitution
  const historyMessages: LLMMessage[] = buildMessageHistoryWithSummaries(
    params.messageHistory ?? [],
    params.summaries ?? [],
    params.turnInput.locale,
  );

  // Pre-history segments precede history and the current turn: the player
  // message, then the story this execution already produced. Depth segments
  // are inserted relative to this base, then post-history segments.
  const storyMessages = buildExecutionStoryMessages(
    params.executionStory ?? [],
    buildExecutionStoryCue(params.turnInput.locale),
  );
  const currentMessage: LLMMessage = {
    role: "user",
    content: buildCurrentTurnUserMessage(params.turnInput),
  };
  const baseMessages: readonly LLMMessage[] = [
    ...(segments.preHistoryExtensions ?? []),
    ...historyMessages,
    currentMessage,
    ...storyMessages,
  ];

  // Insert depth-positioned lore and extension segments.
  const withDepthContributions = insertDepthContributions(
    baseMessages,
    segments.depthContributions,
  );

  // Segment 8 — this turn's data and turn-volatile segments, as one system
  // message between the history and the current turn. It was system prompt
  // content and keeps that role; an adapter that lifts system messages to the
  // top sends it as before. It is not the last thing before the reply: there,
  // small models copied the syntax of the data blocks into their tool calls.
  const turnContext = [segments.turnData, segments.turnContextExtensions]
    .filter(Boolean)
    .join("\n\n");
  // Depth positions count conversation messages, so it goes in afterwards.
  const turnStart = withDepthContributions.indexOf(currentMessage);
  // Recent pictures open the current turn, after the turn context: they are
  // rebuilt every turn like it, and the history before them stays as it was.
  const pictures = buildRecentPicturesMessage(
    params.messageHistory ?? [],
    params.pictureAttachments ?? 0,
    params.turnInput.locale,
  );

  // Segment 10 — append post-history instructions after everything else.
  const messages: readonly LLMMessage[] = [
    ...withDepthContributions.slice(0, turnStart),
    ...(turnContext ? [{ role: "system" as const, content: turnContext }] : []),
    ...(pictures ? [pictures] : []),
    ...withDepthContributions.slice(turnStart),
    ...segments.postHistoryInstructions,
  ];

  // The budget protects trailing user-role messages. The player message is
  // followed by the story cue and by any post-history or shallow-depth
  // segment a plugin declared with the user role; count those too, so the
  // protected window still starts at the player message.
  const currentTurnUserMessages =
    1 +
    (pictures ? 1 : 0) +
    messages
      .slice(messages.indexOf(currentMessage) + 1)
      .filter((message) => message.role === "user").length;

  const budgetEnabled =
    params.estimator !== undefined && params.contextBudget !== undefined;

  if (budgetEnabled) {
    const result = applyBudget(systemPrompt, messages, {
      ...params.contextBudget!,
      protectLastUserTurns:
        (params.contextBudget!.protectLastUserTurns ??
          DEFAULT_PROTECT_LAST_USER_TURNS) +
        currentTurnUserMessages -
        1,
      estimator: params.estimator!,
      locale: params.turnInput.locale,
    });
    return {
      systemPrompt,
      frameworkHead,
      messages: result.messages,
      turnContext,
      currentTurnUserMessages,
      prunedMessageCount: result.prunedMessageCount,
    };
  }

  return {
    systemPrompt,
    frameworkHead,
    messages,
    turnContext,
    currentTurnUserMessages,
  };
}
