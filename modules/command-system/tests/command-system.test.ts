import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  CommandBus,
  CommandError,
  CommandRegistry,
  SlashCommandSpecSchema,
  SlashParser,
  createSlashCommandSpec
} from "../src/index.js";

describe("SlashCommandSpec", () => {
  it("accepts the minimal runtime spec plus help and autocomplete metadata", () => {
    const spec = createSlashCommandSpec({
      name: "memory",
      description: "Search memory",
      handler: "server/commands/memory.ts",
      resume: false,
      argsSchema: z.object({
        _: z.array(z.string()).max(1),
        scope: z.enum(["world", "session"]).optional()
      }),
      execute: async ({ _ }) => _[0] ?? "all",
      help: {
        usage: "/memory <query> [--scope world|session]",
        examples: [
          "/memory observatory",
          "/memory key --scope session"
        ]
      },
      autocomplete: {
        positionalHints: ["query"],
        flagHints: [
          {
            name: "--scope",
            description: "Restrict the search scope",
            takesValue: true
          }
        ]
      }
    });

    expect(SlashCommandSpecSchema.parse(spec)).toEqual(spec);
  });

  it("rejects invalid command metadata", () => {
    const result = SlashCommandSpecSchema.safeParse({
      name: "",
      description: "",
      handler: "",
      resume: false,
      argsSchema: z.object({}),
      execute: async () => null
    });

    expect(result.success).toBe(false);
  });
});

describe("SlashParser", () => {
  it("parses positionals, quoted values, and flags", () => {
    const parser = new SlashParser();

    expect(parser.parse('/memory "ancient lore" --limit 3 --verbose')).toEqual({
      raw: '/memory "ancient lore" --limit 3 --verbose',
      name: "memory",
      args: {
        _: ["ancient lore"],
        limit: "3",
        verbose: true
      },
      tokens: ["ancient lore", "--limit", "3", "--verbose"]
    });
  });

  it("raises a structured error for non slash input", () => {
    const parser = new SlashParser();

    expect(() => parser.parse("memory ancient lore")).toThrowError(CommandError);
    expect(() => parser.parse("memory ancient lore")).toThrowError(/slash/i);
  });
});

describe("CommandRegistry", () => {
  it("registers commands and exposes help and autocomplete metadata", () => {
    const registry = new CommandRegistry();

    registry.register(createMemoryCommand());

    expect(registry.listHelp()).toEqual([
      {
        name: "memory",
        description: "Search memory",
        usage: "/memory <query> [--limit <n>] [--verbose]"
      }
    ]);

    expect(registry.listAutocomplete()).toEqual([
      {
        name: "memory",
        positionalHints: ["query"],
        flagHints: [
          {
            name: "--limit",
            description: "Maximum result count",
            takesValue: true
          },
          {
            name: "--verbose",
            description: "Include debug diagnostics",
            takesValue: false
          }
        ]
      }
    ]);
  });

  it("rejects duplicate registrations with a structured error", () => {
    const registry = new CommandRegistry();
    const spec = createMemoryCommand();

    registry.register(spec);

    expect(() => registry.register(spec)).toThrowError(CommandError);

    try {
      registry.register(spec);
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).code).toBe("DUPLICATE_COMMAND");
      expect((error as CommandError).details).toMatchObject({ name: "memory" });
    }
  });
});

describe("CommandBus", () => {
  it("parses input, validates args with zod, and invokes the handler", async () => {
    const registry = new CommandRegistry();
    registry.register(createMemoryCommand());

    const bus = new CommandBus({ registry });

    await expect(
      bus.dispatch('/memory "ancient lore" --limit 3 --verbose', {
        actorId: "user-1"
      })
    ).resolves.toEqual({
      actorId: "user-1",
      query: "ancient lore",
      limit: 3,
      verbose: true
    });
  });

  it("returns structured validation errors when argsSchema rejects input", async () => {
    const registry = new CommandRegistry();
    registry.register(createMemoryCommand());

    const bus = new CommandBus({ registry });

    await expect(bus.dispatch("/memory")).rejects.toBeInstanceOf(CommandError);

    try {
      await bus.dispatch("/memory");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).code).toBe("ARGUMENT_VALIDATION_FAILED");
      expect((error as CommandError).details).toMatchObject({
        commandName: "memory"
      });
      expect((error as CommandError).issues).toEqual([
        {
          path: "query",
          message: "Invalid input: expected string, received undefined"
        }
      ]);
    }
  });

  it("returns a structured error when the command does not exist", async () => {
    const bus = new CommandBus({ registry: new CommandRegistry() });

    await expect(bus.dispatch("/missing")).rejects.toBeInstanceOf(CommandError);

    try {
      await bus.dispatch("/missing");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).code).toBe("COMMAND_NOT_FOUND");
      expect((error as CommandError).details).toMatchObject({
        name: "missing"
      });
    }
  });
});

function createMemoryCommand() {
  return createSlashCommandSpec({
    name: "memory",
    description: "Search memory",
    handler: "server/commands/memory.ts",
    resume: false,
    argsSchema: z.preprocess((value) => {
      const rawArgs = value as { _: string[]; limit?: string; verbose?: boolean };

      return {
        query: rawArgs._[0],
        limit: rawArgs.limit,
        verbose: rawArgs.verbose ?? false
      };
    }, z.object({
      query: z.string().min(1),
      limit: z.coerce.number().int().positive().default(5),
      verbose: z.boolean().default(false)
    })),
    execute: async (args, context) => ({
      actorId: context.actorId,
      ...args
    }),
    help: {
      usage: "/memory <query> [--limit <n>] [--verbose]"
    },
    autocomplete: {
      positionalHints: ["query"],
      flagHints: [
        {
          name: "--limit",
          description: "Maximum result count",
          takesValue: true
        },
        {
          name: "--verbose",
          description: "Include debug diagnostics",
          takesValue: false
        }
      ]
    }
  });
}
