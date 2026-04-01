import { CommandError } from "./error.js";

export interface ParsedSlashArgs {
  _: string[];
  [key: string]: string | boolean | string[];
}

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: ParsedSlashArgs;
  tokens: string[];
}

/**
 * Parse slash command input into structured form.
 *
 * Supports:
 * - Positional args: `/cmd foo bar`
 * - Quoted strings: `/cmd "hello world"`
 * - Flags with values: `/cmd --key value`
 * - Boolean flags: `/cmd --verbose`
 */
export function parseSlashCommand(input: string): ParsedSlashCommand {
  const raw = input.trim();

  if (!raw.startsWith("/")) {
    throw new CommandError({
      code: "INVALID_COMMAND_INPUT",
      message: "Slash commands must start with '/'.",
      details: { input },
    });
  }

  const tokens = tokenize(raw.slice(1));
  const [name, ...argumentTokens] = tokens;

  if (!name) {
    throw new CommandError({
      code: "INVALID_COMMAND_INPUT",
      message: "Slash commands require a command name.",
      details: { input },
    });
  }

  const args: ParsedSlashArgs = { _: [] };

  for (let i = 0; i < argumentTokens.length; i++) {
    const token = argumentTokens[i];

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const flagName = token.slice(2);
    if (!flagName) {
      throw new CommandError({
        code: "INVALID_COMMAND_INPUT",
        message: "Flags must include a name after '--'.",
        details: { input },
      });
    }

    const nextToken = argumentTokens[i + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      args[flagName] = nextToken;
      i++;
    } else {
      args[flagName] = true;
    }
  }

  return { raw, name, args, tokens: argumentTokens };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        current += input[i + 1];
        i++;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new CommandError({
      code: "INVALID_COMMAND_INPUT",
      message: "Slash command contains an unterminated quoted argument.",
      details: { input },
    });
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
