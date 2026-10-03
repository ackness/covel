import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { Document, parseDocument } from "yaml";
import { canonicalizeLocale, isKnownLocale } from "@covel/shared";
import {
  MANIFEST_ARRAY_KEYS,
  MANIFEST_LABEL_KEYS,
  manifestFilesOf,
  readManifestLabels,
  type ManifestLabels,
} from "./locale-labels.js";
import {
  MESSAGES_SECTION,
  missingTranslations,
  readMessageCatalogs,
} from "./locale-messages.js";

/**
 * What a translator of a plugin works on: which texts exist, which a language
 * lacks, which translations were made from an English text that has since
 * changed, and how to write new translations into `locales/<locale>.yaml`.
 *
 * `messages` (UI and code text) is keyed by the English text, so a changed
 * text shows up as a missing translation. A label is addressed by its place
 * in the manifest, so a changed label would keep its old translation; the
 * lock file `locales/lock.json` records the English text each label
 * translation was made from.
 */

/** One step from the manifest root to a label: a key, or a list item by its id. */
export type LabelStep =
  string | { readonly by: string; readonly value: string | number };

export interface LabelUnit {
  /** The manifest file, relative to the plugin root. */
  readonly file: string;
  readonly steps: readonly LabelStep[];
  /** The place as text, such as `contributes.commands[name=bag].description`. */
  readonly pointer: string;
  /** The English text. */
  readonly text: string;
}

export interface PluginTranslationStatus {
  readonly locale: string;
  readonly labels: {
    readonly total: number;
    readonly missing: readonly LabelUnit[];
    /** Translated from an English text that has changed since. */
    readonly stale: readonly LabelUnit[];
    /** Translated, with no record of the English text it was made from. */
    readonly unlocked: readonly LabelUnit[];
  };
  readonly messages: {
    readonly total: number;
    readonly missing: readonly { file: string; where: string; text: string }[];
  };
}

const LOCK_FILE = "locales/lock.json";

interface LabelLock {
  version: 1;
  /** locale → `<file>#<pointer>` → hash of the English text. */
  labels: Record<string, Record<string, string>>;
}

function hashOf(text: string): string {
  return createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

function elementKey(items: readonly unknown[]): string | undefined {
  return MANIFEST_ARRAY_KEYS.find((key) =>
    items.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (typeof (item as Record<string, unknown>)[key] === "string" ||
          typeof (item as Record<string, unknown>)[key] === "number"),
    ),
  );
}

function pointerOf(steps: readonly LabelStep[]): string {
  return steps
    .map((step, index) =>
      typeof step === "string"
        ? `${index === 0 ? "" : "."}${step}`
        : `[${step.by}=${step.value}]`,
    )
    .join("");
}

/** Every label of a manifest's frontmatter, with its place. */
function labelUnits(file: string, frontmatter: unknown): LabelUnit[] {
  const units: LabelUnit[] = [];
  const walk = (value: unknown, steps: readonly LabelStep[]): void => {
    if (Array.isArray(value)) {
      const by = elementKey(value);
      // A list whose items have no id cannot be addressed by a locale file.
      if (!by) return;
      for (const item of value)
        walk(item, [
          ...steps,
          { by, value: (item as Record<string, string | number>)[by]! },
        ]);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // Prompt segments are instructions; `PLUGIN.zh.md` translates them.
      if (steps.length === 1 && steps[0] === "contributes" && key === "prompt")
        continue;
      // A data namespace's description is for world authors, who read the
      // English; the player-facing text is its `authoring.title` / `summary`.
      if (
        key === "description" &&
        steps.length === 3 &&
        steps[0] === "contributes" &&
        steps[1] === "data"
      )
        continue;
      const next = [...steps, key];
      if (typeof child === "string") {
        if (MANIFEST_LABEL_KEYS.has(key) && child.trim())
          units.push({
            file,
            steps: next,
            pointer: pointerOf(next),
            text: child,
          });
      } else walk(child, next);
    }
  };
  walk(frontmatter, []);
  return units;
}

/** The value at a label's place in a locale file's section, if any. */
function valueAt(section: unknown, steps: readonly LabelStep[]): unknown {
  let current = section;
  for (const step of steps) {
    if (current === null || typeof current !== "object") return undefined;
    if (typeof step === "string")
      current = (current as Record<string, unknown>)[step];
    else
      current = Array.isArray(current)
        ? current.find(
            (item) =>
              item !== null &&
              typeof item === "object" &&
              (item as Record<string, unknown>)[step.by] === step.value,
          )
        : undefined;
  }
  return current;
}

/** Set the value at a label's place, creating the objects and items on the way. */
function setAt(
  section: Record<string, unknown>,
  steps: readonly LabelStep[],
  text: string,
): void {
  let current: unknown = section;
  steps.forEach((step, index) => {
    const last = index === steps.length - 1;
    const next = steps[index + 1];
    const empty = () =>
      next !== undefined && typeof next !== "string" ? [] : {};
    if (typeof step === "string") {
      const object = current as Record<string, unknown>;
      if (last) object[step] = text;
      else {
        if (object[step] === null || typeof object[step] !== "object")
          object[step] = empty();
        current = object[step];
      }
      return;
    }
    const list = current as Record<string, unknown>[];
    let item = list.find((entry) => entry?.[step.by] === step.value);
    if (!item) {
      item = { [step.by]: step.value };
      list.push(item);
    }
    current = item;
  });
}

/** Every label of the plugin's manifests, in file order. */
export async function pluginLabelUnits(
  pluginRoot: string,
): Promise<LabelUnit[]> {
  const units: LabelUnit[] = [];
  for (const file of await manifestFilesOf(pluginRoot)) {
    let content: string;
    try {
      content = await fs.readFile(path.join(pluginRoot, file), "utf-8");
    } catch {
      continue;
    }
    units.push(...labelUnits(file, matter(content, { language: "yaml" }).data));
  }
  return units;
}

async function readLock(pluginRoot: string): Promise<LabelLock> {
  try {
    const lock = JSON.parse(
      await fs.readFile(path.join(pluginRoot, LOCK_FILE), "utf-8"),
    ) as LabelLock;
    if (lock?.version === 1 && lock.labels) return lock;
  } catch {
    // No lock yet.
  }
  return { version: 1, labels: {} };
}

/** The locales the plugin has a `locales/<locale>.yaml` for. */
export async function pluginLocales(pluginRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(pluginRoot, "locales"));
  } catch {
    return [];
  }
  return names
    .map((name) => /^(.+)\.ya?ml$/.exec(name)?.[1])
    .flatMap((tag) => {
      const locale = tag ? canonicalizeLocale(tag) : undefined;
      // `locales/notes.yaml` is not a translation: the name must be a language.
      return locale && isKnownLocale(locale) ? [locale] : [];
    })
    .sort();
}

/** What `locale` translates of the plugin, and what it lacks. */
export async function pluginTranslationStatus(
  pluginRoot: string,
  locale: string,
): Promise<PluginTranslationStatus> {
  const units = await pluginLabelUnits(pluginRoot);
  const lock = (await readLock(pluginRoot)).labels[locale] ?? {};
  const sections = new Map<string, readonly ManifestLabels[]>();
  for (const file of new Set(units.map((unit) => unit.file)))
    sections.set(
      file,
      (await readManifestLabels(pluginRoot, file)).filter(
        (labels) => labels.locale === locale,
      ),
    );

  const missing: LabelUnit[] = [];
  const stale: LabelUnit[] = [];
  const unlocked: LabelUnit[] = [];
  for (const unit of units) {
    const translated = (sections.get(unit.file) ?? []).filter(
      (labels) => typeof valueAt(labels.overlay, unit.steps) === "string",
    );
    if (translated.length === 0) {
      missing.push(unit);
      continue;
    }
    // The lock file records the author's translations only.
    if (!translated.some((labels) => labels.origin === "plugin")) continue;
    const recorded = lock[`${unit.file}#${unit.pointer}`];
    if (recorded === undefined) unlocked.push(unit);
    else if (recorded !== hashOf(unit.text)) stale.push(unit);
  }

  const missingMessages = await missingTranslations(pluginRoot, locale);
  const translated = (await readMessageCatalogs(pluginRoot)).find(
    (catalog) => catalog.locale === locale,
  );
  return {
    locale,
    labels: { total: units.length, missing, stale, unlocked },
    messages: {
      total:
        new Set(missingMessages.map((item) => item.text)).size +
        Object.keys(translated?.messages ?? {}).length,
      missing: missingMessages,
    },
  };
}

/**
 * Record, for every translated label, the English text it now belongs to.
 * Run it after the translations were checked against the English text.
 */
export async function lockPluginLabels(pluginRoot: string): Promise<number> {
  const units = await pluginLabelUnits(pluginRoot);
  const labels: LabelLock["labels"] = {};
  let count = 0;
  for (const locale of await pluginLocales(pluginRoot)) {
    const entries: Record<string, string> = {};
    for (const file of new Set(units.map((unit) => unit.file))) {
      const section = (await readManifestLabels(pluginRoot, file)).find(
        (item) => item.locale === locale && item.origin === "plugin",
      )?.overlay;
      for (const unit of units)
        if (
          unit.file === file &&
          typeof valueAt(section, unit.steps) === "string"
        )
          entries[`${unit.file}#${unit.pointer}`] = hashOf(unit.text);
    }
    if (Object.keys(entries).length > 0) {
      labels[locale] = Object.fromEntries(Object.entries(entries).sort());
      count += Object.keys(entries).length;
    }
  }
  const lockPath = path.join(pluginRoot, LOCK_FILE);
  if (count === 0) {
    await fs.rm(lockPath, { force: true });
    return 0;
  }
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ version: 1, labels } satisfies LabelLock, null, 2)}\n`,
  );
  return count;
}

/**
 * Write translations into `locales/<locale>.yaml`: labels at their places,
 * messages under the English text. Comments at the top of the file are kept.
 *
 * `directory` writes the file somewhere else than the plugin's `locales/`:
 * the plugin's folder in the translations directory, for a translation that
 * is not the author's.
 */
export async function writePluginTranslations(
  pluginRoot: string,
  locale: string,
  translations: {
    readonly labels?: readonly { unit: LabelUnit; text: string }[];
    readonly messages?: Readonly<Record<string, string>>;
  },
  directory: string = path.join(pluginRoot, "locales"),
): Promise<string> {
  const file = path.join(directory, `${locale}.yaml`);
  let document: Document;
  try {
    document = parseDocument(await fs.readFile(file, "utf-8"));
  } catch {
    document = new Document({});
    document.commentBefore = ` ${locale} text of this plugin.\n A section named after a manifest file translates its labels, under the same keys.\n messages translates the UI and the code: English text, then its translation.`;
  }
  const plain = (document.toJS() ?? {}) as Record<string, unknown>;

  const byFile = new Map<string, { unit: LabelUnit; text: string }[]>();
  for (const item of translations.labels ?? [])
    byFile.set(item.unit.file, [...(byFile.get(item.unit.file) ?? []), item]);
  for (const [manifest, items] of byFile) {
    const section =
      plain[manifest] !== null && typeof plain[manifest] === "object"
        ? (structuredClone(plain[manifest]) as Record<string, unknown>)
        : {};
    for (const { unit, text } of items) setAt(section, unit.steps, text);
    document.set(manifest, document.createNode(section));
  }

  const messages = Object.entries(translations.messages ?? {});
  if (messages.length > 0) {
    // Labels first, the catalog last: add the section when it is missing.
    if (!document.has(MESSAGES_SECTION))
      document.set(MESSAGES_SECTION, document.createNode({}));
    for (const [text, translation] of messages)
      document.setIn([MESSAGES_SECTION, text], translation);
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, document.toString({ lineWidth: 0 }));
  return file;
}
