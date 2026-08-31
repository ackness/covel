import { describe, expect, it } from "vitest";
import {
  parseSlashCommandInvocation,
  parseStructuredSlashCommandInvocation,
  tokenizeSlashCommand,
  type SlashCommandSpec,
} from "../src/index.js";

const command: SlashCommandSpec = {
  name: "roll",
  aliases: ["r"],
  description: "Roll dice",
  action: "roll",
  arguments: [
    { name: "count", type: "integer", required: true },
    { name: "private", type: "boolean" },
    { name: "labels", variadic: true },
  ],
};

describe("slash command parsing", () => {
  it("tokenizes quotes and escapes without doing shell expansion", () => {
    expect(
      tokenizeSlashCommand('/roll 2 true "red dragon" literal\\ value'),
    ).toEqual({
      ok: true,
      tokens: ["/roll", "2", "true", "red dragon", "literal value"],
    });
    expect(tokenizeSlashCommand("/roll `whoami` $HOME $(pwd)")).toEqual({
      ok: true,
      tokens: ["/roll", "`whoami`", "$HOME", "$(pwd)"],
    });
  });

  it("coerces declared positional arguments and supports aliases", () => {
    expect(
      parseSlashCommandInvocation(command, "/r 2 false alpha beta"),
    ).toEqual({
      ok: true,
      invocation: {
        command: "roll",
        canonical: "/roll 2 false alpha beta",
        raw: "/r 2 false alpha beta",
        argv: ["2", "false", "alpha", "beta"],
        args: { count: 2, private: false, labels: ["alpha", "beta"] },
      },
    });
    expect(parseSlashCommandInvocation(command, "/ROLL 2")).toMatchObject({
      ok: true,
      invocation: { command: "roll", args: { count: 2 } },
    });
  });

  it("normalizes structured UI args into the same canonical invocation", () => {
    expect(
      parseStructuredSlashCommandInvocation(command, {
        count: 2,
        private: false,
        labels: ["red dragon", "beta"],
      }),
    ).toEqual({
      ok: true,
      invocation: {
        command: "roll",
        canonical: '/roll 2 false "red dragon" beta',
        raw: '/roll 2 false "red dragon" beta',
        argv: ["2", "false", "red dragon", "beta"],
        args: { count: 2, private: false, labels: ["red dragon", "beta"] },
      },
    });
    expect(
      parseStructuredSlashCommandInvocation(command, {
        count: "2",
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid-argument",
      argument: "count",
    });
    expect(
      parseStructuredSlashCommandInvocation(command, {
        count: 2,
        unexpected: true,
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid-argument",
      argument: "unexpected",
    });
  });

  it("fails closed on missing, invalid, extra, and unterminated arguments", () => {
    expect(parseSlashCommandInvocation(command, "/roll")).toMatchObject({
      ok: false,
      code: "missing-argument",
      argument: "count",
    });
    expect(parseSlashCommandInvocation(command, "/roll nope")).toMatchObject({
      ok: false,
      code: "invalid-argument",
    });
    expect(tokenizeSlashCommand('/roll "open')).toMatchObject({
      ok: false,
      code: "unterminated-quote",
    });
    expect(
      parseSlashCommandInvocation(
        { ...command, arguments: command.arguments?.slice(0, 1) },
        "/roll 2 extra",
      ),
    ).toMatchObject({ ok: false, code: "too-many-arguments" });
  });
});
