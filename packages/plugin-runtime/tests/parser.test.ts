import { describe, it, expect } from "vitest";
import { parseSlashCommand, CommandError } from "../src/index.js";

describe("slash command parser", () => {
  it("parses a simple command with no args", () => {
    const result = parseSlashCommand("/help");
    expect(result.name).toBe("help");
    expect(result.args._).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it("parses positional arguments", () => {
    const result = parseSlashCommand("/guide combat basics");
    expect(result.name).toBe("guide");
    expect(result.args._).toEqual(["combat", "basics"]);
  });

  it("parses flags with values", () => {
    const result = parseSlashCommand("/memory --limit 10 --topic quest");
    expect(result.name).toBe("memory");
    expect(result.args.limit).toBe("10");
    expect(result.args.topic).toBe("quest");
    expect(result.args._).toEqual([]);
  });

  it("parses boolean flags", () => {
    const result = parseSlashCommand("/debug --verbose --json");
    expect(result.name).toBe("debug");
    expect(result.args.verbose).toBe(true);
    expect(result.args.json).toBe(true);
  });

  it("parses quoted arguments", () => {
    const result = parseSlashCommand('/guide "hello world" --topic "my quest"');
    expect(result.name).toBe("guide");
    expect(result.args._).toEqual(["hello world"]);
    expect(result.args.topic).toBe("my quest");
  });

  it("handles single-quoted arguments", () => {
    const result = parseSlashCommand("/guide 'hello world'");
    expect(result.args._).toEqual(["hello world"]);
  });

  it("handles escaped characters in quotes", () => {
    const result = parseSlashCommand('/guide "say \\"hello\\""');
    expect(result.args._).toEqual(['say "hello"']);
  });

  it("preserves raw input", () => {
    const result = parseSlashCommand("/guide foo --bar baz");
    expect(result.raw).toBe("/guide foo --bar baz");
  });

  it("throws on non-slash input", () => {
    expect(() => parseSlashCommand("not a command")).toThrow(CommandError);
  });

  it("throws on empty command name", () => {
    expect(() => parseSlashCommand("/")).toThrow(CommandError);
  });

  it("throws on unterminated quote", () => {
    expect(() => parseSlashCommand('/guide "unterminated')).toThrow(CommandError);
  });

  it("throws on empty flag name", () => {
    expect(() => parseSlashCommand("/guide -- value")).toThrow(CommandError);
  });

  it("mixes positional and flag args", () => {
    const result = parseSlashCommand("/search query --limit 5 extra");
    expect(result.name).toBe("search");
    expect(result.args._).toEqual(["query", "extra"]);
    expect(result.args.limit).toBe("5");
  });
});
