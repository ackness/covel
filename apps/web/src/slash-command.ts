import type { CommandSummary } from "./types.js";

function normalizeSearchValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveSlashCommandQuery(input: string): string | null {
  if (!input.startsWith("/") || input.includes("\n")) {
    return null;
  }

  const rawQuery = input.slice(1);
  return /\s/.test(rawQuery) ? null : rawQuery.trim().toLowerCase();
}

export function resolveSlashCommandSuggestions(
  input: string,
  commands: CommandSummary[]
): CommandSummary[] {
  const query = resolveSlashCommandQuery(input);
  if (query === null) {
    return [];
  }

  const normalizedQuery = normalizeSearchValue(query);
  const ranked = commands
    .reduce<Array<{ command: CommandSummary; score: number }>>((entries, command) => {
      const score = scoreCommand(command, query, normalizedQuery);
      if (score !== null) {
        entries.push({ command, score });
      }
      return entries;
    }, [])
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      return left.command.name.localeCompare(right.command.name);
    });

  return ranked.map((entry) => entry.command);
}

export function autocompleteSlashCommand(command: CommandSummary): string {
  return `/${command.name} `;
}

function scoreCommand(
  command: CommandSummary,
  query: string,
  normalizedQuery: string
): number | null {
  if (query.length === 0) {
    return 100;
  }

  const name = command.name.toLowerCase();
  const usage = command.usage.toLowerCase();
  const description = command.description.toLowerCase();
  const normalizedName = normalizeSearchValue(command.name);
  const exampleText = (command.examples ?? []).join(" ").toLowerCase();
  const positionalText = (command.positionalHints ?? []).join(" ").toLowerCase();
  const flagText = (command.flagHints ?? [])
    .map((flag) => `${flag.name} ${flag.description}`)
    .join(" ")
    .toLowerCase();

  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (normalizedQuery.length > 0 && normalizedName.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(query)) {
    return 3;
  }
  if (normalizedQuery.length > 0 && normalizedName.includes(normalizedQuery)) {
    return 4;
  }
  if (usage.includes(query)) {
    return 5;
  }
  if (description.includes(query)) {
    return 6;
  }
  if (flagText.includes(query) || positionalText.includes(query) || exampleText.includes(query)) {
    return 7;
  }

  return null;
}
