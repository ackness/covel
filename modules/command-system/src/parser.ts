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

export class SlashParser {
  parse(input: string): ParsedSlashCommand {
    const raw = input.trim();

    if (!raw.startsWith("/")) {
      throw new CommandError({
        code: "INVALID_COMMAND_INPUT",
        message: "Slash commands must start with '/'.",
        details: { input }
      });
    }

    const tokens = tokenizeSlashInput(raw.slice(1));
    const [name, ...argumentTokens] = tokens;

    if (!name) {
      throw new CommandError({
        code: "INVALID_COMMAND_INPUT",
        message: "Slash commands require a command name.",
        details: { input }
      });
    }

    const args: ParsedSlashArgs = { _: [] };

    for (let index = 0; index < argumentTokens.length; index += 1) {
      const token = argumentTokens[index];

      if (!token.startsWith("--")) {
        args._.push(token);
        continue;
      }

      const flagName = token.slice(2);
      const nextToken = argumentTokens[index + 1];

      if (!flagName) {
        throw new CommandError({
          code: "INVALID_COMMAND_INPUT",
          message: "Flags must include a name after '--'.",
          details: { input }
        });
      }

      if (nextToken && !nextToken.startsWith("--")) {
        args[flagName] = nextToken;
        index += 1;
        continue;
      }

      args[flagName] = true;
    }

    return {
      raw,
      name,
      args,
      tokens: argumentTokens
    };
  }
}

function tokenizeSlashInput(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }

      if (character === "\\" && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }

      current += character;
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new CommandError({
      code: "INVALID_COMMAND_INPUT",
      message: "Slash command contains an unterminated quoted argument.",
      details: { input }
    });
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
