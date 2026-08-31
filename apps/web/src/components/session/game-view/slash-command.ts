import type {
  SessionSlashCommand,
  SlashCommandArgumentSpec,
} from "@covel/shared";

export interface SlashCommandQuery {
  readonly name: string;
  readonly hasArguments: boolean;
}

export function readSlashCommandQuery(input: string): SlashCommandQuery | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const whitespaceIndex = trimmed.search(/\s/u);
  const token =
    whitespaceIndex === -1 ? trimmed : trimmed.slice(0, whitespaceIndex);
  return {
    name: token.slice(1).toLowerCase(),
    hasArguments: whitespaceIndex !== -1,
  };
}

function commandMatches(
  command: SessionSlashCommand,
  query: SlashCommandQuery,
): boolean {
  const names = [command.name, ...(command.aliases ?? [])];
  return query.hasArguments
    ? names.includes(query.name)
    : names.some((name) => name.startsWith(query.name));
}

function matchRank(
  command: SessionSlashCommand,
  query: SlashCommandQuery,
): number {
  if (command.name === query.name) return 0;
  if ((command.aliases ?? []).includes(query.name)) return 1;
  if (command.name.startsWith(query.name)) return 2;
  return 3;
}

export function matchSlashCommands(
  commands: readonly SessionSlashCommand[],
  input: string,
): SessionSlashCommand[] {
  const query = readSlashCommandQuery(input);
  if (!query) return [];
  return commands
    .filter((command) => commandMatches(command, query))
    .sort((a, b) => {
      const rank = matchRank(a, query) - matchRank(b, query);
      if (rank !== 0) return rank;
      const framework =
        Number(b.source === "framework") - Number(a.source === "framework");
      return (
        framework || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      );
    });
}

export function commandAcceptsTypedName(
  command: SessionSlashCommand,
  input: string,
): boolean {
  const query = readSlashCommandQuery(input);
  return (
    query !== null &&
    (query.name === command.name ||
      (command.aliases ?? []).includes(query.name))
  );
}

function argumentUsage(argument: SlashCommandArgumentSpec): string {
  const label = argument.variadic ? `${argument.name}...` : argument.name;
  return argument.required ? `<${label}>` : `[${label}]`;
}

export function slashCommandUsage(command: SessionSlashCommand): string {
  const suffix = (command.arguments ?? []).map(argumentUsage).join(" ");
  return suffix ? `/${command.name} ${suffix}` : `/${command.name}`;
}

export function completeSlashCommand(command: SessionSlashCommand): string {
  return `/${command.name}${command.arguments?.length ? " " : ""}`;
}
