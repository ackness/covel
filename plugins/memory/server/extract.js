import { isDefaultLocale, resolveI18nText } from "@covel/plugin-handlers-utils";
import { loadDefinitions } from "./definitions.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  applyUpdatesToBlockSnapshot,
  buildShortenPrompt,
  cutAtSentence,
  enforceAuthoritativePlayerProfile,
  parseMemoryUpdate,
} from "./extraction.js";
import { factKey, factText, recentFacts, withoutRepeats } from "./facts.js";
import { retryTransientProviderCall } from "./provider-retry.js";

const MAX_REPLY_ATTEMPTS = 2;
const DEFAULT_BLOCK_CHARS = 2000;

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
  const lang = isDefaultLocale(locale) ? "zh" : "en";
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
    const response = await retryTransientProviderCall(() => {
      ctx.signal.throwIfAborted();
      return ctx.gateway.generateText({
        presetId: "memory",
        defaults: { reasoningEffort: "disabled" },
        system: buildSystemPrompt(definitions, lang, locale),
        prompt,
        signal: ctx.signal,
      });
    });
    ctx.signal.throwIfAborted();
    try {
      extracted = parseMemoryUpdate(response.text, labels);
    } catch (error) {
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
  for (const [index, fact] of newFacts.entries()) {
    ctx.signal.throwIfAborted();
    await ctx.pluginData.set("facts", factKey(turn, index), {
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
    const response = await retryTransientProviderCall(() => {
      ctx.signal.throwIfAborted();
      return ctx.gateway.generateText({
        presetId: "memory",
        defaults: { reasoningEffort: "disabled" },
        ...buildShortenPrompt(content, limit, lang, locale),
        signal: ctx.signal,
      });
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
