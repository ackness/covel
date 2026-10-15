import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extractGlossary,
  translateTexts,
  type TranslationUnit,
} from "@covel/create";
import { canonicalizeLocale, type LLMAdapter } from "@covel/shared";
import {
  worldTranslationStatus,
  writeWorldTranslations,
} from "./locale-tooling.js";

/** Fields of world data that hold a name: translated first, then reused. */
const NAME_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "displayName",
  "title",
  "aliases",
  "label",
  "leader",
  "headquarters",
  "era",
  "giver",
]);

export type TranslateWorldStep = "glossary" | "names" | "texts" | "long texts";

export interface TranslateWorldOptions {
  readonly worldDir: string;
  /** The language to translate into. */
  readonly locale: string;
  readonly llm: LLMAdapter;
  readonly model?: string;
  readonly signal?: AbortSignal;
  /** Longest wait for the next output of the model in each call. */
  readonly idleTimeoutMs?: number;
  /** Texts done and texts in all, for the step that is running. */
  readonly onProgress?: (
    step: TranslateWorldStep,
    done: number,
    total: number,
  ) => void;
}

export interface TranslateWorldResult {
  /** The language the world is written in. */
  readonly from: string;
  /** Texts that lacked a translation before this run. */
  readonly total: number;
  readonly translated: number;
  /** Locale files written, relative to the world directory. */
  readonly written: readonly string[];
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

export interface PreparedWorldTranslation extends Omit<
  TranslateWorldResult,
  "written"
> {
  readonly translations: ReadonlyMap<string, string>;
}

/** The texts of a world that `locale` does not translate yet. */
export async function untranslatedWorldTexts(
  worldDir: string,
  locale: string,
): Promise<{
  from: string;
  units: TranslationUnit[];
  names: Set<string>;
  glossary: Record<string, string>;
}> {
  const state = await worldTranslationStatus(worldDir, locale);
  const units: TranslationUnit[] = [];
  const names = new Set<string>();
  // Names and terms with a fixed translation: source text to target text.
  const glossary: Record<string, string> = {};
  for (const file of state.files) {
    // What the language already translates is kept as it is.
    for (const term of file.terms) glossary[term.source] ??= term.target;
    for (const unit of file.missing) {
      const field = unit.pointer
        .replace(/(\[[^\]]*\])+$/, "")
        .split(".")
        .at(-1);
      units.push({
        id: unit.id,
        text: unit.text,
        ...(unit.prose ? {} : { note: field }),
      });
      if (!unit.prose && NAME_FIELDS.has(field ?? "") && unit.text.length <= 40)
        names.add(unit.id);
    }
  }
  return { from: state.baseLocale, units, names, glossary };
}

/**
 * Generate the missing translations in memory without changing the package.
 * A host may then check package ownership before publishing the result.
 *
 * A name must have one translation in every file. So the names and terms of
 * the world are listed first, the name fields are translated next, and each
 * later call is given the names its texts use.
 */
export async function prepareWorldTranslation(
  options: TranslateWorldOptions,
): Promise<PreparedWorldTranslation> {
  const { worldDir, locale, llm } = options;
  const signal = options.signal ?? new AbortController().signal;
  const { from, units, names, glossary } = await untranslatedWorldTexts(
    worldDir,
    locale,
  );
  if (units.length === 0)
    return {
      from,
      total: 0,
      translated: 0,
      translations: new Map(),
      failed: [],
    };

  const model = {
    ...(options.model ? { model: options.model } : {}),
    idleTimeoutMs: options.idleTimeoutMs,
  };
  // Long texts (lore, a rule) go alone; short ones share a call.
  const long = units.filter((unit) => unit.text.length > 1500);
  const short = units.filter((unit) => unit.text.length <= 1500);

  const lore = await readFile(path.join(worldDir, "WORLD.md"), "utf-8").catch(
    () => "",
  );
  const nameTexts = [
    ...new Set(
      short.filter((unit) => names.has(unit.id)).map((unit) => unit.text),
    ),
  ];
  options.onProgress?.("glossary", 0, 1);
  Object.assign(
    glossary,
    await extractGlossary({
      llm,
      ...model,
      signal,
      text: `${nameTexts.join("\n")}\n\n${lore}`,
      from,
      to: locale,
      known: glossary,
    }),
  );
  options.onProgress?.("glossary", 1, 1);

  const translations: Record<string, string> = {};
  const failed: { id: string; reason: string }[] = [];
  for (const [step, batch, batchSize] of [
    ["names", short.filter((unit) => names.has(unit.id)), 40],
    ["texts", short.filter((unit) => !names.has(unit.id)), 30],
    ["long texts", long, 1],
  ] as const) {
    if (batch.length === 0) continue;
    const result = await translateTexts({
      llm,
      ...model,
      signal,
      units: batch,
      from,
      to: locale,
      context:
        "content of a world for a text role-playing game: names, descriptions, rules and story text. Translate names of people and places in the way a published translation would",
      glossary,
      batchSize,
      onProgress: (done, total) => options.onProgress?.(step, done, total),
    });
    Object.assign(translations, result.translations);
    failed.push(...result.failed);
    if (step === "names")
      for (const unit of batch) {
        const target = result.translations[unit.id];
        if (target && target !== unit.text) glossary[unit.text] ??= target;
      }
  }

  return {
    from,
    total: units.length,
    translated: Object.keys(translations).length,
    translations: new Map(Object.entries(translations)),
    failed,
  };
}

/** Translate a package owned by the caller and write its language files. */
export async function translateWorldPackage(
  options: TranslateWorldOptions,
): Promise<TranslateWorldResult> {
  const { translations, ...result } = await prepareWorldTranslation(options);
  const written = await writeWorldTranslations(
    options.worldDir,
    options.locale,
    translations,
  );
  return { ...result, written };
}

/**
 * Make sure the world has an edition in `locale`. A world has one while it
 * has `world.<locale>.yaml` or `WORLD.<locale>.md`; when a translation wrote
 * neither, an empty `world.<locale>.yaml` is written. Returns the file
 * written, if any.
 */
export async function ensureWorldEdition(
  worldDir: string,
  locale: string,
): Promise<string | undefined> {
  const wanted = canonicalizeLocale(locale) ?? locale;
  for (const file of [`world.${wanted}.yaml`, `WORLD.${wanted}.md`])
    if (await stat(path.join(worldDir, file)).catch(() => undefined))
      return undefined;
  const file = `world.${wanted}.yaml`;
  await writeFile(path.join(worldDir, file), "{}\n");
  return file;
}
