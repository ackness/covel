import { describe, expect, it } from "vitest";
import type { SessionSlashCommand } from "@covel/shared";
import {
  commandAcceptsTypedName,
  matchSlashCommands,
  readSlashCommandQuery,
  slashCommandUsage,
} from "../game-view/slash-command.js";

const command = (
  id: string,
  name: string,
  aliases: readonly string[] = [],
  source: "framework" | "plugin" = "plugin",
): SessionSlashCommand => ({
  id,
  pluginId: source === "framework" ? "framework" : id.split(":")[0]!,
  source,
  name,
  aliases,
  description: name,
  action: name,
});
describe("composer slash command matching", () => {
  const commands = [
    command("dice:roll", "roll", ["r"]),
    command("framework:debug", "debug", ["trace"], "framework"),
    command("inventory:bag", "bag", ["inventory"]),
  ];

  it("only reads a slash command from the first input token", () => {
    expect(readSlashCommandQuery(" /ro")).toEqual({
      name: "ro",
      hasArguments: false,
    });
    expect(readSlashCommandQuery("say /roll")).toBeNull();
  });

  it("matches canonical prefixes and aliases, then narrows during arguments", () => {
    expect(matchSlashCommands(commands, "/r").map((item) => item.name)).toEqual(
      ["roll"],
    );
    expect(matchSlashCommands(commands, "/roll 2d6")).toEqual([commands[0]]);
    expect(matchSlashCommands(commands, "/rotten arg")).toEqual([]);
  });

  it("recognizes aliases and formats positional usage", () => {
    const roll = {
      ...commands[0]!,
      arguments: [
        { name: "count", required: true },
        { name: "labels", variadic: true },
      ],
    };
    expect(commandAcceptsTypedName(roll, "/r 2")).toBe(true);
    expect(slashCommandUsage(roll)).toBe("/roll <count> [labels...]");
  });
});
