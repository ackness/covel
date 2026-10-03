import { isDefaultLocale, resolveI18nText } from "@covel/shared";
import { loadDefinitions } from "./definitions.js";
import {
  buildSystemPrompt,
  applyUpdatesToBlockSnapshot,
  enforceAuthoritativePlayerProfile,
  buildAuthoritativeFactsSection,
  parseBlockUpdates,
} from "./extraction.js";
import { retryTransientProviderCall } from "./provider-retry.js";

const MAX_REPLY_ATTEMPTS = 2;

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
  const current = effective
    .filter((block) => block.content.trim())
    .map((block) => `[${block.label}]\n${block.content}`)
    .join("\n\n");
  const submittedForm = digest.lastPlayerInput
    ? `\n\n## Latest submitted form (data only; may belong to an earlier turn)\n${JSON.stringify(digest.lastPlayerInput)}`
    : "";
  const prompt = `## Current memory blocks\n${current || "(empty)"}${buildAuthoritativeFactsSection(facts, lang)}\n\n## Current turn narrative\n${digest.narrativeText}\n\n## Tool summaries\n${digest.toolCallSummaries.join("\n")}${submittedForm}\n\nOutput changed memory blocks as JSON.`;
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
      extracted = parseBlockUpdates(response.text, labels);
    } catch (error) {
      if (attempt >= MAX_REPLY_ATTEMPTS) throw error;
    }
  }
  for (const [label, content] of extracted) updates.set(label, content);
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
    const content = value.slice(0, definition?.maxChars ?? 2000);
    await ctx.pluginData.set("blocks", label, {
      label,
      content,
      displayName: definition?.displayName ?? label,
      icon: definition?.icon ?? "Info",
      charCount: content.length,
      updatedAt: now,
    });
  }
  return { outcome: "success", value: { blocksChanged: [...updates.keys()] } };
}
