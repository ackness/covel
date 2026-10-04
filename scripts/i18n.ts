/**
 * Translation tooling for plugin and world packages.
 *
 *   pnpm i18n status <dir>... [--locale <tag>] [--missing]
 *   pnpm i18n extract <plugin-dir> --locale <tag>
 *   pnpm i18n lock <plugin-dir>...
 *   pnpm i18n translate <dir> --locale <tag> [--slot <name>] [--dry-run] [--to <translations-dir>]
 *
 * A directory with `PLUGIN.md` is a plugin, one with `world.yaml` a world.
 *
 * - `status` counts what each language translates and, with `--missing`,
 *   lists what it lacks. For a plugin it also lists label translations made
 *   from an English text that has changed since (`stale`).
 * - `extract` prints the entries a plugin lacks in a language, as YAML to
 *   fill in and add to `locales/<locale>.yaml`.
 * - `lock` records, for each label translation of a plugin, the English text
 *   it belongs to. Run it after the translations were checked.
 * - `translate` asks the configured model for what is missing or stale and
 *   writes the locale files. It reads `llm.toml` and the provider keys from
 *   the environment, as the server does. Check the result before a release:
 *   a model translation is a draft.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
// By path: a package-name import can resolve to a stale copy in a worktree.
import {
  translateTexts,
  type TranslationUnit,
} from "../packages/create/src/index.js";
import {
  lockPluginLabels,
  pluginLocales,
  setTranslationsDirectory,
  pluginTranslationStatus,
  writePluginTranslations,
  type LabelUnit,
} from "../packages/plugin-loader/src/index.js";
import { worldTranslationStatus } from "../apps/server/src/world-data/locale-tooling.js";
import {
  translateWorldPackage,
  untranslatedWorldTexts,
} from "../apps/server/src/world-data/translate-world.js";
import {
  conventionsOfPlugins,
  setWorldDataConventions,
} from "../apps/server/src/world-data/conventions.js";
import { loadPluginCatalogue } from "../apps/server/src/world-data/validate-world-package.js";

const USAGE = `Usage:
  pnpm i18n status <dir>... [--locale <tag>] [--missing]
  pnpm i18n extract <plugin-dir> --locale <tag>
  pnpm i18n lock <plugin-dir>...
  pnpm i18n translate <dir> --locale <tag> [--slot <name>] [--dry-run] [--to <translations-dir>]

  --to <translations-dir>   For a plugin: count the translations in that
                            directory, and write new ones there
                            (<translations-dir>/plugins/<id>/<tag>.yaml)
                            instead of into the plugin package.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const dirs: string[] = [];
let locale: string | undefined;
let slot: string | undefined;
let listMissing = false;
let dryRun = false;
let translationsDir: string | undefined;
for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index]!;
  if (arg === "--locale") locale = rest[++index];
  else if (arg === "--slot") slot = rest[++index];
  else if (arg === "--missing") listMissing = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--to") translationsDir = rest[++index];
  else if (arg.startsWith("--")) fail(`Unknown option ${arg}\n${USAGE}`);
  else dirs.push(arg);
}
if (!command || dirs.length === 0) fail(USAGE);
if (translationsDir) setTranslationsDirectory(translationsDir);
// A world without a descriptor is read by the paths that the bundled plugins
// name for their data.
if (dirs.some((dir) => existsSync(path.join(dir, "world.yaml"))))
  setWorldDataConventions(
    conventionsOfPlugins(
      await loadPluginCatalogue([
        path.resolve(import.meta.dirname, "../plugins"),
      ]),
    ),
  );

type Kind = "plugin" | "world";
function kindOf(dir: string): Kind {
  if (existsSync(path.join(dir, "PLUGIN.md"))) return "plugin";
  if (existsSync(path.join(dir, "world.yaml"))) return "world";
  return fail(`${dir}: not a plugin (PLUGIN.md) or a world (world.yaml)`);
}

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 70 ? `${line.slice(0, 70)}…` : line);
}

async function status(dir: string): Promise<void> {
  if (kindOf(dir) === "plugin") {
    const locales = locale ? [locale] : await pluginLocales(dir);
    if (locales.length === 0)
      console.log(`${dir}: no locale files (English only)`);
    for (const tag of locales) {
      const state = await pluginTranslationStatus(dir, tag);
      const messages = new Set(state.messages.missing.map((item) => item.text));
      console.log(
        `${dir} [${tag}]  labels ${state.labels.total - state.labels.missing.length}/${state.labels.total}` +
          (state.labels.stale.length
            ? `, ${state.labels.stale.length} stale`
            : "") +
          (state.labels.unlocked.length
            ? `, ${state.labels.unlocked.length} not locked`
            : "") +
          `  messages ${state.messages.total - messages.size}/${state.messages.total}`,
      );
      if (!listMissing) continue;
      for (const unit of state.labels.missing)
        console.log(
          `  missing label  ${unit.file}: ${unit.pointer} = ${short(unit.text)}`,
        );
      for (const unit of state.labels.stale)
        console.log(
          `  stale label    ${unit.file}: ${unit.pointer} = ${short(unit.text)}`,
        );
      for (const text of messages)
        console.log(`  missing text   ${short(text)}`);
    }
    return;
  }
  if (!locale) fail(`${dir}: a world needs --locale <tag>`);
  const state = await worldTranslationStatus(dir, locale);
  const total = state.files.reduce((sum, file) => sum + file.total, 0);
  const missing = state.files.reduce(
    (sum, file) => sum + file.missing.length,
    0,
  );
  console.log(
    `${dir} [${locale}]  ${total - missing}/${total} texts (written in ${state.baseLocale})`,
  );
  for (const file of state.files) {
    console.log(
      `  ${String(file.total - file.missing.length).padStart(4)}/${String(file.total).padEnd(4)} ${file.file} → ${file.localeFile}`,
    );
    if (file.notTranslatable?.length)
      console.log(
        `        ${file.notTranslatable.length} value(s) cannot be translated: their schema node is not marked x-i18n (${file.notTranslatable.slice(0, 3).join(", ")}${file.notTranslatable.length > 3 ? ", …" : ""})`,
      );
    if (listMissing)
      for (const unit of file.missing)
        console.log(
          `        missing ${unit.pointer || "(whole file)"} = ${short(unit.text)}`,
        );
  }
}

/** A nested YAML skeleton with an empty string at each label's place. */
function labelSkeleton(units: readonly LabelUnit[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const unit of units) {
    let current: unknown = (root[unit.file] ??= {});
    unit.steps.forEach((step, index) => {
      const last = index === unit.steps.length - 1;
      const next = unit.steps[index + 1];
      if (typeof step === "string") {
        const object = current as Record<string, unknown>;
        if (last) object[step] = `TODO: ${unit.text}`;
        else
          current = object[step] ??=
            next !== undefined && typeof next !== "string" ? [] : {};
        return;
      }
      const list = current as Record<string, unknown>[];
      let item = list.find((entry) => entry[step.by] === step.value);
      if (!item) list.push((item = { [step.by]: step.value }));
      current = item;
    });
  }
  return root;
}

async function extract(dir: string): Promise<void> {
  if (kindOf(dir) !== "plugin") fail("extract works on a plugin directory");
  if (!locale) fail("extract needs --locale <tag>");
  const state = await pluginTranslationStatus(dir, locale);
  const labels = [...state.labels.missing, ...state.labels.stale];
  const texts = [...new Set(state.messages.missing.map((item) => item.text))];
  if (labels.length === 0 && texts.length === 0) {
    console.error(`${dir} [${locale}]: nothing is missing`);
    return;
  }
  console.error(
    `# ${labels.length} label(s) and ${texts.length} text(s) to translate into ${locale}.`,
  );
  console.error(
    `# Replace each "TODO: …" with the translation and merge into ${path.join(dir, "locales", `${locale}.yaml`)}.`,
  );
  process.stdout.write(
    stringifyYaml(
      {
        ...labelSkeleton(labels),
        ...(texts.length > 0
          ? {
              messages: Object.fromEntries(
                texts.map((text) => [text, `TODO: ${text}`]),
              ),
            }
          : {}),
      },
      { lineWidth: 0 },
    ),
  );
}

async function modelAdapter() {
  // The server's own stack: llm.toml for the routes, the environment for keys.
  const [
    { createAiStack },
    { createGatewayAdapter },
    { providerApiKeysFromEnv },
  ] = await Promise.all([
    import("../apps/server/src/ai-setup.js"),
    import("../packages/runtime/src/index.js"),
    import("../packages/shared/src/index.js"),
  ]);
  const ai = createAiStack();
  return createGatewayAdapter(ai.gateway, {
    envApiKeys: providerApiKeysFromEnv(process.env),
    modelTargets: new Map(),
  });
}

async function translate(dir: string): Promise<void> {
  if (!locale) fail("translate needs --locale <tag>");
  if (kindOf(dir) === "world") return translateWorld(dir, locale);

  const units: TranslationUnit[] = [];
  const labelUnits = new Map<string, LabelUnit>();
  const state = await pluginTranslationStatus(dir, locale);
  for (const unit of [...state.labels.missing, ...state.labels.stale]) {
    const id = `label:${unit.file}#${unit.pointer}`;
    labelUnits.set(id, unit);
    units.push({ id, text: unit.text, note: `label (${unit.steps.at(-1)})` });
  }
  for (const text of new Set(state.messages.missing.map((item) => item.text)))
    units.push({ id: `message:${text}`, text });

  if (units.length === 0) {
    console.log(`${dir} [${locale}]: nothing to translate`);
    return;
  }
  console.log(`${dir} [${locale}]: ${units.length} text(s) to translate`);
  if (dryRun) {
    for (const unit of units) console.log(`  ${unit.id} = ${short(unit.text)}`);
    return;
  }

  const result = await translateTexts({
    llm: await modelAdapter(),
    ...(slot ? { model: slot } : {}),
    signal: new AbortController().signal,
    units,
    from: "en",
    to: locale,
    context:
      "labels and interface text of a plugin for a text role-playing game",
    glossary: {},
    batchSize: 30,
    onProgress: (done, total) =>
      process.stdout.write(`\r  texts: ${done}/${total}   `),
  });
  process.stdout.write("\n");
  const { translations, failed } = result;

  const labels = Object.entries(translations).flatMap(([id, text]) => {
    const unit = labelUnits.get(id);
    return unit ? [{ unit, text }] : [];
  });
  const messages = Object.fromEntries(
    Object.entries(translations)
      .filter(([id]) => id.startsWith("message:"))
      .map(([id, text]) => [id.slice("message:".length), text]),
  );
  if (translationsDir) {
    // Not the author's translation: it stays outside the package.
    const file = await writePluginTranslations(
      dir,
      locale,
      { labels, messages },
      path.join(translationsDir, "plugins", path.basename(path.resolve(dir))),
    );
    console.log(`  wrote ${file}`);
  } else {
    const file = await writePluginTranslations(dir, locale, {
      labels,
      messages,
    });
    await lockPluginLabels(dir);
    console.log(`  wrote ${file} and locales/lock.json`);
  }
  for (const item of failed)
    console.error(`  not translated: ${item.id} (${item.reason})`);
  if (failed.length > 0) process.exitCode = 1;
}

async function translateWorld(dir: string, target: string): Promise<void> {
  const { units } = await untranslatedWorldTexts(dir, target);
  if (units.length === 0) {
    console.log(`${dir} [${target}]: nothing to translate`);
    return;
  }
  console.log(`${dir} [${target}]: ${units.length} text(s) to translate`);
  if (dryRun) {
    for (const unit of units) console.log(`  ${unit.id} = ${short(unit.text)}`);
    return;
  }
  let step = "";
  const result = await translateWorldPackage({
    worldDir: dir,
    locale: target,
    llm: await modelAdapter(),
    ...(slot ? { model: slot } : {}),
    onProgress: (current, done, total) => {
      if (step && step !== current) process.stdout.write("\n");
      step = current;
      process.stdout.write(`\r  ${current}: ${done}/${total}   `);
    },
  });
  process.stdout.write("\n");
  for (const file of result.written)
    console.log(`  wrote ${path.join(dir, file)}`);
  for (const item of result.failed)
    console.error(`  not translated: ${item.id} (${item.reason})`);
  if (result.failed.length > 0) process.exitCode = 1;
}

switch (command) {
  case "status":
    for (const dir of dirs) await status(dir);
    break;
  case "extract":
    await extract(dirs[0]!);
    break;
  case "lock":
    for (const dir of dirs) {
      if (kindOf(dir) !== "plugin") fail("lock works on plugin directories");
      console.log(
        `${dir}: ${await lockPluginLabels(dir)} label translation(s) locked`,
      );
    }
    break;
  case "translate":
    await translate(dirs[0]!);
    break;
  default:
    fail(`Unknown command ${command}\n${USAGE}`);
}
