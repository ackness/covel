import type {
  SlashCommandArgumentSpec,
  SlashCommandInvocation,
  SlashCommandSpec,
} from "../types/plugin.js";

export type SlashCommandParseResult =
  | { readonly ok: true; readonly invocation: SlashCommandInvocation }
  | {
      readonly ok: false;
      readonly code:
        | "invalid-prefix"
        | "unterminated-quote"
        | "command-mismatch"
        | "missing-argument"
        | "too-many-arguments"
        | "invalid-argument";
      readonly message: string;
      readonly argument?: string;
    };

type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "unterminated-quote";
      readonly message: string;
    };

/**
 * Split command input using a deliberately small shell-like grammar.
 * Quotes and backslash escapes are supported; expansion, evaluation,
 * substitutions, globs, and environment variables do not exist.
 */
export function tokenizeSlashCommand(input: string): TokenizeResult {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }

  if (escaped) token += "\\";
  if (quote) {
    return {
      ok: false,
      code: "unterminated-quote",
      message: "Command contains an unterminated quote",
    };
  }
  if (started) tokens.push(token);
  return { ok: true, tokens };
}

function coerceArgument(
  raw: string,
  spec: SlashCommandArgumentSpec,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (spec.choices && !spec.choices.includes(raw)) return { ok: false };
  switch (spec.type ?? "string") {
    case "string":
      return { ok: true, value: raw };
    case "integer": {
      if (!/^-?\d+$/u.test(raw)) return { ok: false };
      const value = Number(raw);
      return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
    }
    case "number": {
      if (raw.trim() === "") return { ok: false };
      const value = Number(raw);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    case "boolean":
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false };
  }
}

function canonicalArgument(value: unknown): string {
  if (typeof value !== "string") return String(value);
  return /^[^\s"'\\]+$/u.test(value) ? value : JSON.stringify(value);
}

function buildCanonicalCommand(
  spec: SlashCommandSpec,
  argv: readonly string[],
): string {
  return [`/${spec.name}`, ...argv.map(canonicalArgument)].join(" ");
}

function coerceStructuredArgument(
  value: unknown,
  spec: SlashCommandArgumentSpec,
):
  | { readonly ok: true; readonly value: unknown; readonly argv: string }
  | {
      readonly ok: false;
    } {
  if (spec.choices && !spec.choices.includes(String(value))) {
    return { ok: false };
  }
  switch (spec.type ?? "string") {
    case "string":
      if (typeof value !== "string") return { ok: false };
      return { ok: true, value, argv: value };
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? { ok: true, value, argv: String(value) }
        : { ok: false };
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value, argv: String(value) }
        : { ok: false };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value, argv: String(value) }
        : { ok: false };
  }
}

/** Parse and type-check one invocation against its server-selected spec. */
export function parseSlashCommandInvocation(
  spec: SlashCommandSpec,
  raw: string,
): SlashCommandParseResult {
  const tokenized = tokenizeSlashCommand(raw);
  if (!tokenized.ok) return tokenized;
  const [commandToken, ...argv] = tokenized.tokens;
  if (!commandToken?.startsWith("/")) {
    return {
      ok: false,
      code: "invalid-prefix",
      message: "Command input must start with /",
    };
  }
  const typedName = commandToken.slice(1).toLowerCase();
  if (typedName !== spec.name && !(spec.aliases ?? []).includes(typedName)) {
    return {
      ok: false,
      code: "command-mismatch",
      message: `Input command /${typedName} does not match /${spec.name}`,
    };
  }

  const args: Record<string, unknown> = {};
  const argumentSpecs = spec.arguments ?? [];
  let cursor = 0;
  for (const argument of argumentSpecs) {
    const values = argument.variadic
      ? argv.slice(cursor)
      : argv.slice(cursor, cursor + 1);
    if (values.length === 0) {
      if (argument.required) {
        return {
          ok: false,
          code: "missing-argument",
          argument: argument.name,
          message: `Missing required argument: ${argument.name}`,
        };
      }
      continue;
    }
    const coerced = values.map((value) => coerceArgument(value, argument));
    if (coerced.some((value) => !value.ok)) {
      return {
        ok: false,
        code: "invalid-argument",
        argument: argument.name,
        message: `Invalid value for argument: ${argument.name}`,
      };
    }
    args[argument.name] = argument.variadic
      ? coerced.map((value) => (value as { value: unknown }).value)
      : (coerced[0] as { value: unknown }).value;
    cursor += values.length;
  }
  if (cursor < argv.length) {
    return {
      ok: false,
      code: "too-many-arguments",
      message: "Command has too many arguments",
    };
  }
  return {
    ok: true,
    invocation: {
      command: spec.name,
      canonical: buildCanonicalCommand(spec, argv),
      raw: raw.trim(),
      argv,
      args,
    },
  };
}

/** Validate named JSON args and normalize them into the text parser's shape. */
export function parseStructuredSlashCommandInvocation(
  spec: SlashCommandSpec,
  structuredArgs: Readonly<Record<string, unknown>>,
): SlashCommandParseResult {
  const argumentSpecs = spec.arguments ?? [];
  const knownNames = new Set(argumentSpecs.map((argument) => argument.name));
  const unknownName = Object.keys(structuredArgs).find(
    (name) => !knownNames.has(name),
  );
  if (unknownName) {
    return {
      ok: false,
      code: "invalid-argument",
      argument: unknownName,
      message: `Unknown argument: ${unknownName}`,
    };
  }

  const args: Record<string, unknown> = {};
  const argv: string[] = [];
  let omittedOptional = false;
  for (const argument of argumentSpecs) {
    if (!Object.hasOwn(structuredArgs, argument.name)) {
      if (argument.required) {
        return {
          ok: false,
          code: "missing-argument",
          argument: argument.name,
          message: `Missing required argument: ${argument.name}`,
        };
      }
      omittedOptional = true;
      continue;
    }

    const rawValue = structuredArgs[argument.name];
    const values = argument.variadic
      ? Array.isArray(rawValue)
        ? rawValue
        : null
      : [rawValue];
    if (!values) {
      return {
        ok: false,
        code: "invalid-argument",
        argument: argument.name,
        message: `Variadic argument must be an array: ${argument.name}`,
      };
    }
    if (values.length === 0) {
      if (argument.required) {
        return {
          ok: false,
          code: "missing-argument",
          argument: argument.name,
          message: `Missing required argument: ${argument.name}`,
        };
      }
      omittedOptional = true;
      continue;
    }
    if (omittedOptional) {
      return {
        ok: false,
        code: "invalid-argument",
        argument: argument.name,
        message: `Argument cannot follow an omitted optional argument: ${argument.name}`,
      };
    }
    const coerced = values.map((value) =>
      coerceStructuredArgument(value, argument),
    );
    if (coerced.some((value) => !value.ok)) {
      return {
        ok: false,
        code: "invalid-argument",
        argument: argument.name,
        message: `Invalid value for argument: ${argument.name}`,
      };
    }
    const normalized = coerced as ReadonlyArray<{
      readonly ok: true;
      readonly value: unknown;
      readonly argv: string;
    }>;
    args[argument.name] = argument.variadic
      ? normalized.map((value) => value.value)
      : normalized[0]!.value;
    argv.push(...normalized.map((value) => value.argv));
  }

  const canonical = buildCanonicalCommand(spec, argv);
  return {
    ok: true,
    invocation: {
      command: spec.name,
      canonical,
      raw: canonical,
      argv,
      args,
    },
  };
}
