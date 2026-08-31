import { describe, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  type ParsedPluginMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import {
  buildCommandEnvironment,
  buildSessionCommandList,
  mergePluginCommands,
} from "../../src/routes/api/session/commands.js";

function manifest(
  runtimeId: string,
  commandDescription = "Inspect",
): RuntimeManifest {
  return {
    name: runtimeId,
    pluginId: "inspector",
    description: "Inspector runtime",
    outputKind: "story",
    model: "story",
    capabilities: ["narrative"],
    commands: [
      {
        name: "inspect",
        aliases: ["i"],
        description: commandDescription,
        action: "inspect-state",
        context: ["session", "active-runtimes", "models"],
      },
    ],
  };
}

function entry(manifests: readonly RuntimeManifest[]): PluginRegistryEntry {
  return {
    id: "inspector",
    summary: {
      id: "inspector",
      name: "Inspector",
      description: "Inspector",
      pluginType: "plugin",
      runtimeCount: manifests.length,
    },
    status: "registered",
    source: "builtin",
    loadedRuntimes: new Map(),
    manifests: manifests.map((runtime): ParsedPluginMd => ({
      manifest: runtime,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
  } as PluginRegistryEntry;
}

const session = {
  id: "session-1",
  worldId: "world-1",
  status: "active",
  phase: "playing",
  locale: "en-US",
  activePlugins: ["inspector"],
  runtimeModelOverrides: { "inspector/story": "deep" },
} as SessionRecord;

describe("session slash command directory", () => {
  it("merges runtime declarations by name and warns on divergence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const commands = mergePluginCommands(
      entry([
        manifest("inspector/story"),
        manifest("inspector/other", "Other"),
      ]),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.description).toBe("Inspect");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("declared differently"),
    );
    warn.mockRestore();
  });

  it("returns framework commands plus commands from active plugins only", () => {
    const registry = createPluginRegistry();
    registry.register(entry([manifest("inspector/story")]));

    expect(
      buildSessionCommandList([], registry).map((command) => command.id),
    ).toEqual(["framework:debug"]);
    expect(
      buildSessionCommandList(["inspector"], registry).map(
        (command) => command.id,
      ),
    ).toEqual(["framework:debug", "inspector:inspect"]);
  });
});

describe("slash command context scopes", () => {
  it("does no environment work for context-free commands", () => {
    const resolveModel = vi.fn(() => "model-x");
    expect(
      buildCommandEnvironment({
        command: {},
        session,
        activeRuntimes: [manifest("inspector/story")],
        resolveModel,
      }),
    ).toBeUndefined();
    expect(resolveModel).not.toHaveBeenCalled();
  });

  it("injects only declared facets and resolves current model overrides", () => {
    const resolveModel = vi.fn((_runtime, override) => `resolved:${override}`);
    const environment = buildCommandEnvironment({
      command: { context: ["models"] },
      session,
      activeRuntimes: [manifest("inspector/story")],
      resolveModel,
    });

    expect(environment?.session).toBeUndefined();
    expect(environment?.activeRuntimes).toEqual([
      expect.objectContaining({
        id: "inspector/story",
        outputKind: "story",
        model: {
          slot: "deep",
          resolved: "resolved:deep",
          source: "session-override",
        },
      }),
    ]);
  });
});
