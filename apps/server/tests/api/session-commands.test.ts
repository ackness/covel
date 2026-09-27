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
    outputContract: "narrative@1",
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
    packageManifest: {
      plugin: {
        id: "inspector",
        kind: "plugin",
        description: "Inspector",
        contributes: { commands: manifests[0]?.commands ?? [] },
      },
      manifest: manifests[0],
      promptTemplate: "",
      rawFrontmatter: {},
    },
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
  it("reads commands only from the root contribution", () => {
    const item = entry([
      manifest("inspector/story"),
      manifest("inspector/other", "Other"),
    ]);
    expect(mergePluginCommands(item)).toEqual(
      manifest("inspector/story").commands,
    );
    expect(
      mergePluginCommands({ ...item, packageManifest: undefined }),
    ).toEqual([]);
  });

  it("returns framework commands plus commands from active plugins only", () => {
    const registry = createPluginRegistry();
    registry.register(entry([manifest("inspector/story")]));

    expect(
      buildSessionCommandList([], registry).map((command) => command.id),
    ).toEqual(["framework:plugins", "framework:debug"]);
    expect(
      buildSessionCommandList(["inspector"], registry).map(
        (command) => command.id,
      ),
    ).toEqual(["framework:plugins", "framework:debug", "inspector:inspect"]);
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
