import {
  instructionLocaleFor,
  resolveI18nText,
} from "@covel/plugin-handlers-utils";
import { loadDefinitions } from "./definitions.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  applyUpdatesToBlockSnapshot,
  buildShortenPrompt,
  cutAtSentence,
  enforceAuthoritativePlayerProfile,
  memoryUpdateSchema,
  parseMemoryUpdate,
} from "./extraction.js";
import {
  factKey,
  factText,
  nextFactIndex,
  recentFacts,
  withoutRepeats,
} from "./facts.js";

const MAX_REPLY_ATTEMPTS = 2;
const DEFAULT_BLOCK_CHARS = 2000;
/** How much of a reply that cannot be read is kept in the log, from each end. */
const UNREADABLE_REPLY_HEAD_CHARS = 600;
const UNREADABLE_REPLY_TAIL_CHARS = 300;

/** The start and the end of a reply, enough to see why it did not parse. */
function replyExcerpt(text) {
  if (text.length <= UNREADABLE_REPLY_HEAD_CHARS + UNREADABLE_REPLY_TAIL_CHARS)
    return text;
  return `${text.slice(0, UNREADABLE_REPLY_HEAD_CHARS)} … ${text.slice(-UNREADABLE_REPLY_TAIL_CHARS)}`;
}

/** One scheduler-owned attempt; proposals commit with the detached job receipt. */
export default async function extractMemory(ctx) {
  const digest = ctx.inputs?.turn?.value;
  if (!digest?.narrativeText?.trim())
    return { outcome: "skipped", reason: "no-story-output" };
  if (!ctx.gateway || !ctx.pluginData)
    throw new Error("Memory extraction requires gateway and own plugin data");
  const definitions = await loadDefinitions(ctx);
  const records = await ctx.pluginData.list("blocks");
  const byLabel = new Map(records.map((row) => [row.key, row.value]));
  const currentBlocks = definitions.map((block) => ({
    label: block.label,
    content: byLabel.get(block.label)?.content ?? "",
  }));
  const locale = ctx.locale ?? digest.locale ?? "zh-CN";
  const lang = instructionLocaleFor(locale);
  const player = ctx.world?.characters.find(
    (character) => character.type === "player",
  );
  const facts = player
    ? {
        playerCharacter: player,
        playerFieldLabels: Object.fromEntries(
          (ctx.world?.characterSchema?.attributes ?? []).map((attribute) => [
            attribute.id,
            resolveI18nText(attribute.name, locale) ?? attribute.id,
          ]),
        ),
      }
    : undefined;
  const updates = new Map();
  enforceAuthoritativePlayerProfile({
    updates,
    currentBlocks,
    authoritativeFacts: facts,
    lang,
  });
  const effective = applyUpdatesToBlockSnapshot(currentBlocks, updates);
  const factRows = await ctx.pluginData.list("facts");
  const prompt = buildUserPrompt(
    {
      blocks: effective,
      recordedFacts: recentFacts(factRows),
      facts,
      narrative: digest.narrativeText,
      toolSummaries: digest.toolCallSummaries,
      submittedForm: digest.lastPlayerInput,
    },
    lang,
  );
  const labels = new Set(definitions.map((block) => block.label));
  // A reply that cannot be read is asked for one more time. A job reads only
  // its own turn, so a job that fails loses that turn's facts for good.
  let extracted;
  for (let attempt = 1; extracted === undefined; attempt += 1) {
    // The gateway already sends a failed request again and turns to the
    // slot's fallback models; a retry here would multiply those attempts.
    ctx.signal.throwIfAborted();
    const response = await ctx.gateway.generateText({
      presetId: "memory",
      defaults: { reasoningEffort: "disabled" },
      // A provider's JSON mode escapes what free text may not, such as a
      // quotation mark copied from dialogue into a block.
      responseFormat: {
        type: "json_schema",
        schema: memoryUpdateSchema(definitions),
      },
      system: buildSystemPrompt(definitions, lang, locale),
      prompt,
      signal: ctx.signal,
    });
    ctx.signal.throwIfAborted();
    try {
      extracted = parseMemoryUpdate(response.text, labels);
    } catch (error) {
      // The trace keeps no reply text, so this line is the only record of
      // what the model sent.
      await ctx.logger?.warn?.("memory update reply could not be read", {
        attempt,
        reason: error instanceof Error ? error.message : String(error),
        finishReason: response.finishReason,
        replyChars: response.text.length,
        reply: replyExcerpt(response.text),
      });
      if (attempt >= MAX_REPLY_ATTEMPTS) throw error;
    }
  }
  const limitOf = (label) =>
    definitions.find((block) => block.label === label)?.maxChars ??
    DEFAULT_BLOCK_CHARS;
  for (const [label, content] of extracted.blocks) {
    // A block over its limit is shortened by the model, which knows what to
    // keep. Cutting it would drop whatever happened to be written last.
    updates.set(
      label,
      content.length > limitOf(label)
        ? await shortenBlock(ctx, content, limitOf(label), lang, locale)
        : content,
    );
  }
  enforceAuthoritativePlayerProfile({
    updates,
    currentBlocks: effective,
    authoritativeFacts: facts,
    lang,
  });
  const now = new Date().toISOString();
  for (const [label, value] of updates) {
    ctx.signal.throwIfAborted();
    const definition = definitions.find((block) => block.label === label);
    const content = cutAtSentence(value, limitOf(label));
    await ctx.pluginData.set("blocks", label, {
      label,
      content,
      displayName: definition?.displayName ?? label,
      icon: definition?.icon ?? "Info",
      charCount: content.length,
      updatedAt: now,
    });
  }
  // Facts are only added. A block is rewritten every turn and forgets; the
  // facts keep what happened, and memory search reads them.
  const turn = ctx.logicalTurn ?? 0;
  const newFacts = withoutRepeats(extracted.facts, factRows);
  const firstIndex = nextFactIndex(factRows, turn);
  for (const [index, fact] of newFacts.entries()) {
    ctx.signal.throwIfAborted();
    await ctx.pluginData.set("facts", factKey(turn, firstIndex + index), {
      turn,
      text: factText(turn, fact, lang),
    });
  }
  return {
    outcome: "success",
    value: {
      blocksChanged: [...updates.keys()],
      factsAdded: newFacts.length,
    },
  };
}

async function shortenBlock(ctx, content, limit, lang, locale) {
  try {
    ctx.signal.throwIfAborted();
    const response = await ctx.gateway.generateText({
      presetId: "memory",
      defaults: { reasoningEffort: "disabled" },
      ...buildShortenPrompt(content, limit, lang, locale),
      signal: ctx.signal,
    });
    const shortened = response.text.trim();
    if (shortened) return cutAtSentence(shortened, limit);
  } catch (error) {
    ctx.signal.throwIfAborted();
    ctx.logger?.warn?.(
      `memory block not shortened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return cutAtSentence(content, limit);
}
