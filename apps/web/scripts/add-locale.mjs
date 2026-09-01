#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FALLBACK_LOCALE } from "@covel/shared";
import {
  builtInAliasOwner,
  canonicalizeCatalogLocale,
  createLocaleCatalogTemplate,
} from "./check-locale-catalogs.mjs";

const defaultLocalesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/locales",
);

function printUsage(log) {
  log("Usage: pnpm i18n:add <locale> [--locales-dir <directory>]");
  log("Example: pnpm i18n:add ja-JP");
}

function parseCliArgs(args, defaultDirectory) {
  let input;
  let localesDirectory = defaultDirectory;
  let hasLocalesDirectory = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      if (args.length !== 1) {
        throw new Error(`${argument} cannot be combined with other arguments.`);
      }
      return { help: true, localesDirectory };
    }
    if (argument === "--locales-dir") {
      if (hasLocalesDirectory) {
        throw new Error("--locales-dir may only be specified once.");
      }
      const directory = args[index + 1];
      if (!directory || directory.startsWith("-")) {
        throw new Error("--locales-dir requires a directory value.");
      }
      localesDirectory = resolve(directory);
      hasLocalesDirectory = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (input !== undefined) {
      throw new Error(`Unexpected extra argument: ${argument}`);
    }
    input = argument;
  }

  return { help: false, input, localesDirectory };
}

export function validateNewLocale(input, existingCatalogCodes) {
  const locale = input && canonicalizeCatalogLocale(input);
  if (!locale) {
    throw new Error(
      "Locale must be a safe BCP 47 language tag, for example ja-JP or sr-Latn.",
    );
  }

  const canonicalExisting = new Set(
    existingCatalogCodes
      .map(canonicalizeCatalogLocale)
      .filter((code) => code !== undefined),
  );
  if (canonicalExisting.has(locale)) {
    throw new Error(`Locale catalog already exists: ${locale}.json`);
  }

  const aliasOwner = builtInAliasOwner(locale, [...canonicalExisting]);
  if (aliasOwner) {
    throw new Error(
      `Locale ${locale} conflicts with a built-in alias owned by ${aliasOwner}.json; extend ${aliasOwner}.json instead.`,
    );
  }
  return locale;
}

export function runCli(
  args = process.argv.slice(2),
  {
    localesDirectory = defaultLocalesDirectory,
    log = console.log,
    error = console.error,
  } = {},
) {
  let parsedArgs;
  try {
    parsedArgs = parseCliArgs(args, localesDirectory);
  } catch (cause) {
    printUsage(log);
    error(`\n${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  if (parsedArgs.help) {
    printUsage(log);
    return 0;
  }
  const { input } = parsedArgs;
  localesDirectory = parsedArgs.localesDirectory;

  let existingCatalogCodes;
  try {
    existingCatalogCodes = readdirSync(localesDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch (cause) {
    error(
      `Could not read locale catalog directory ${localesDirectory}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }
  let locale;
  try {
    locale = validateNewLocale(input, existingCatalogCodes);
  } catch (cause) {
    printUsage(log);
    error(`\n${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }

  const destinationPath = join(localesDirectory, `${locale}.json`);
  try {
    const sourcePath = join(
      localesDirectory,
      `${DEFAULT_FALLBACK_LOCALE}.json`,
    );
    const fallbackCatalog = JSON.parse(readFileSync(sourcePath, "utf8"));
    const catalog = createLocaleCatalogTemplate(fallbackCatalog, locale);
    writeFileSync(destinationPath, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (cause) {
    error(
      `Could not create ${locale}.json: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }

  const displayPath =
    resolve(localesDirectory) === resolve(defaultLocalesDirectory)
      ? `apps/web/src/i18n/locales/${locale}.json`
      : destinationPath;
  log(`Created ${displayPath} from ${DEFAULT_FALLBACK_LOCALE}.json.`);
  log(
    "Translate values only, then run pnpm check:i18n and pnpm --filter @covel/web test.",
  );
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
