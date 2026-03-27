import { describe, expect, it } from "vitest";

import { autocompleteSlashCommand, resolveSlashCommandQuery, resolveSlashCommandSuggestions } from "../src/slash-command.js";
import type { CommandSummary } from "../src/types.js";

const COMMANDS: CommandSummary[] = [
  {
    name: "guide",
    description: "Generate a guide block.",
    usage: "/guide [topic]"
  },
  {
    name: "packages",
    description: "Inspect runtime packages.",
    usage: "/packages"
  },
  {
    name: "world-seeds",
    description: "Inspect staged world seed content.",
    usage: "/world-seeds [seedId]",
    positionalHints: ["seedId"],
    flagHints: [
      {
        name: "--seed",
        description: "Inspect a staged world seed by id.",
        takesValue: true
      }
    ]
  }
];

describe("slash command helpers", () => {
  it("detects a slash-command query only while the first token is being typed", () => {
    expect(resolveSlashCommandQuery("/wor")).toBe("wor");
    expect(resolveSlashCommandQuery("/world-seeds extra")).toBeNull();
    expect(resolveSlashCommandQuery(" /world-seeds")).toBeNull();
  });

  it("filters commands by command name and metadata", () => {
    expect(resolveSlashCommandSuggestions("/", COMMANDS).map((command) => command.name)).toEqual([
      "guide",
      "packages",
      "world-seeds"
    ]);
    expect(resolveSlashCommandSuggestions("/world", COMMANDS).map((command) => command.name)).toEqual([
      "world-seeds"
    ]);
    expect(resolveSlashCommandSuggestions("/seed", COMMANDS).map((command) => command.name)).toEqual([
      "world-seeds"
    ]);
  });

  it("formats the selected command for composer autocomplete", () => {
    expect(autocompleteSlashCommand(COMMANDS[2]!)).toBe("/world-seeds ");
  });
});
