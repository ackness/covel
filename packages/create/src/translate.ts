import type { LLMAdapter } from "@covel/shared";
import { requestLlmResponse } from "./llm-request.js";

/** One text to translate, with an id the caller knows it by. */
export interface TranslationUnit {
  readonly id: string;
  readonly text: string;
  /** What the text is, when the text alone does not say: "button label". */
  readonly note?: string;
}

export interface TranslateTextsOptions {
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly signal: AbortSignal;
  /** Longest wait for the next output of the model in each call. */
  readonly idleTimeoutMs?: number;
  readonly units: readonly TranslationUnit[];
  /** Locale of the texts, such as `en`. */
  readonly from: string;
  /** Locale to translate to, such as `ja-JP`. */
  readonly to: string;
  /** What the texts belong to: "labels of a dice plugin of an RPG app". */
  readonly context?: string;
  /** Fixed translations of terms: source term to target term. */
  readonly glossary?: Readonly<Record<string, string>>;
  /** Texts per model call. */
  readonly batchSize?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface TranslateTextsResult {
  readonly translations: Readonly<Record<string, string>>;
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * The English name of a locale's language, for the prompt. Chinese is named
 * with its script: "Chinese" alone does not say which one to write.
 */
function languageName(locale: string): string {
  try {
    const tag = new Intl.Locale(locale).maximize();
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const name = names.of(
      tag.language === "zh" && tag.script ? `zh-${tag.script}` : tag.language,
    );
    return name ? `${name} (${locale})` : locale;
  } catch {
    return locale;
  }
}

/** `{name}` and `{{name}}` placeholders: a translation must keep each one. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{?\s*[\w./-]+\s*\}?\}/g)]
    .map(([match]) => match.replace(/\s+/g, ""))
    .sort();
}

function buildPrompt(
  options: TranslateTextsOptions,
  batch: readonly TranslationUnit[],
): string {
  // Only the terms these texts use: a long glossary hides the texts.
  const haystack = batch.map((unit) => unit.text.toLowerCase()).join("\n");
  const glossary = Object.entries(options.glossary ?? {}).filter(([term]) =>
    haystack.includes(term.toLowerCase()),
  );
  return [
    `Translate each text from ${languageName(options.from)} to ${languageName(options.to)}.`,
    options.context ? `The texts are ${options.context}.` : "",
    "",
    "Rules:",
    "- Give one translation for each id. Use the same ids.",
    "- Keep each placeholder as it is: {name}, {{name}}. Do not translate the name in it.",
    "- Keep Markdown marks, line breaks, emoji and leading symbols.",
    "- Keep text in backticks as it is. It is an identifier.",
    "- Translate the meaning. Do not add an explanation and do not remove information.",
    "- A short label stays short.",
    ...(glossary.length > 0
      ? [
          "- Use these translations of terms:",
          ...glossary.map(([term, target]) => `  - ${term} → ${target}`),
        ]
      : []),
    "",
    "Reply with one JSON object and nothing else: each key is an id, each value is the translation.",
    "",
    "Texts:",
    JSON.stringify(
      Object.fromEntries(
        batch.map((unit) => [
          unit.id,
          unit.note ? { text: unit.text, note: unit.note } : unit.text,
        ]),
      ),
      null,
      1,
    ),
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function parseReply(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The translation in a reply value. A model that was shown `{ text, note }`
 * often answers in the same shape.
 */
function translationOf(reply: unknown): string | undefined {
  const text =
    reply !== null && typeof reply === "object"
      ? (reply as { text?: unknown }).text
      : reply;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/** Why a reply cannot be used as the translation of a unit, if it cannot. */
function rejection(unit: TranslationUnit, value: unknown): string | undefined {
  const reply = translationOf(value);
  if (reply === undefined) return "no translation";
  const source = placeholders(unit.text);
  const target = placeholders(reply);
  if (source.join() !== target.join())
    return `placeholders changed: ${source.join(" ") || "(none)"} became ${target.join(" ") || "(none)"}`;
  return undefined;
}

/**
 * Translate texts through a model. Each reply is checked: every id answered,
 * every placeholder kept. A unit that fails is asked for once more, alone
 * with the others that failed; what still fails is returned in `failed` and
 * is left for a person.
 *
 * The same text is translated once, however many units have it, so a name
 * that several files repeat gets one translation.
 */
export async function translateTexts(
  options: TranslateTextsOptions,
): Promise<TranslateTextsResult> {
  const first = new Map<string, TranslationUnit>();
  for (const unit of options.units)
    if (!first.has(unit.text)) first.set(unit.text, unit);
  const distinct = [...first.values()];
  const result = await translateDistinct({ ...options, units: distinct });
  const translations: Record<string, string> = {};
  const failed: { id: string; reason: string }[] = [];
  const reasons = new Map(result.failed.map((item) => [item.id, item.reason]));
  for (const unit of options.units) {
    const source = first.get(unit.text)!;
    const translation = result.translations[source.id];
    if (translation !== undefined) translations[unit.id] = translation;
    else
      failed.push({
        id: unit.id,
        reason: reasons.get(source.id) ?? "no translation",
      });
  }
  return { translations, failed };
}

async function translateDistinct(
  options: TranslateTextsOptions,
): Promise<TranslateTextsResult> {
  const translations: Record<string, string> = {};
  const failed: { id: string; reason: string }[] = [];
  const size = Math.max(1, options.batchSize ?? 40);
  let done = 0;

  const run = async (
    batch: readonly TranslationUnit[],
  ): Promise<{ id: string; reason: string }[]> => {
    const response = await requestLlmResponse({
      llm: options.llm,
      model: options.model,
      signal: options.signal,
      idleTimeoutMs: options.idleTimeoutMs,
      messages: [{ role: "user", content: buildPrompt(options, batch) }],
    });
    const reply = parseReply(response.content ?? "");
    const rejected: { id: string; reason: string }[] = [];
    for (const unit of batch) {
      const reason = reply
        ? rejection(unit, reply[unit.id])
        : "the reply was not a JSON object";
      if (reason) rejected.push({ id: unit.id, reason });
      else translations[unit.id] = translationOf(reply![unit.id])!;
    }
    return rejected;
  };

  for (let index = 0; index < options.units.length; index += size) {
    const batch = options.units.slice(index, index + size);
    let rejected = await run(batch);
    if (rejected.length > 0) {
      const ids = new Set(rejected.map((item) => item.id));
      rejected = await run(batch.filter((unit) => ids.has(unit.id)));
    }
    failed.push(...rejected);
    done += batch.length;
    options.onProgress?.(done, options.units.length);
  }
  return { translations, failed };
}

/**
 * The names and invented terms of a text, each with one translation: people,
 * places, organizations, things the world made up. A world is translated in
 * many calls; without a fixed list a name gets a different translation in
 * each. `known` holds translations that already exist and must be kept.
 */
export async function extractGlossary(options: {
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly signal: AbortSignal;
  readonly idleTimeoutMs?: number;
  readonly text: string;
  readonly from: string;
  readonly to: string;
  readonly known?: Readonly<Record<string, string>>;
}): Promise<Record<string, string>> {
  const known = Object.entries(options.known ?? {});
  const response = await requestLlmResponse({
    llm: options.llm,
    model: options.model,
    signal: options.signal,
    idleTimeoutMs: options.idleTimeoutMs,
    messages: [
      {
        role: "user",
        content: [
          `The text below is in ${languageName(options.from)}. It is the setting of a role-playing game.`,
          `List its proper nouns and invented terms: people, places, organizations, objects and concepts that the setting names. Give each one translation into ${languageName(options.to)}.`,
          "",
          "Rules:",
          "- Write each term as it is written in the text, in its shortest form: `Emberback`, not `Emberback Relay`, when both occur.",
          "- A person gets the full name and, as a second entry, the name people call them by.",
          "- Do not list common words.",
          "- At most 80 terms. The most frequent ones first.",
          ...(known.length > 0
            ? [
                "- These translations exist. Keep them, and translate related terms in the same way:",
                ...known
                  .slice(0, 60)
                  .map(([term, target]) => `  - ${term} → ${target}`),
              ]
            : []),
          "",
          "Reply with one JSON object and nothing else: each key is a term, each value is its translation.",
          "",
          "Text:",
          options.text.slice(0, 16000),
        ].join("\n"),
      },
    ],
  });
  const reply = parseReply(response.content ?? "") ?? {};
  const glossary: Record<string, string> = { ...options.known };
  for (const [term, target] of Object.entries(reply))
    if (typeof target === "string" && target.trim() && term.trim().length >= 2)
      glossary[term.trim()] ??= target.trim();
  return glossary;
}
