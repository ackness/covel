import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import {
  getRuntimeSpec,
  parseSlashCommandInvocation,
  parseStructuredSlashCommandInvocation,
  type PluginRpcCommandRequest,
  type RpcCommandEnvironment,
  type RpcCommandInvocation,
  type RuntimeManifest,
  type SessionSlashCommand,
  type SlashCommandContextScope,
  type SlashCommandSpec,
} from "@covel/shared";
import type { SlashCommandParseResult } from "@covel/shared";
import type { SessionRecord } from "@covel/store";

export const FRAMEWORK_SLASH_COMMANDS: readonly SessionSlashCommand[] = [
  {
    id: "framework:debug",
    pluginId: "framework",
    source: "framework",
    sourceLabel: { zh: "框架", en: "Framework" },
    name: "debug",
    aliases: ["trace"],
    description: {
      zh: "打开当前会话的调试与执行跟踪视图",
      en: "Open debug and execution traces for the current session",
    },
    action: "slash-debug",
    context: ["session", "active-runtimes", "models"],
  },
];

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : item,
  );
}

function entryManifests(
  entry: PluginRegistryEntry,
): readonly RuntimeManifest[] {
  if (entry.manifests) return entry.manifests.map((parsed) => parsed.manifest);
  return entry.manifest ? [entry.manifest.manifest] : [];
}

/** Merge a plugin's runtime declarations by command name. */
export function mergePluginCommands(
  entry: PluginRegistryEntry,
): readonly SlashCommandSpec[] {
  const merged = new Map<
    string,
    { readonly command: SlashCommandSpec; readonly runtimeId: string }
  >();
  for (const manifest of entryManifests(entry)) {
    for (const command of manifest.commands ?? []) {
      const existing = merged.get(command.name);
      if (!existing) {
        merged.set(command.name, { command, runtimeId: manifest.name });
        continue;
      }
      if (stableJson(existing.command) !== stableJson(command)) {
        console.warn(
          `[slash-command] ${entry.id}: /${command.name} is declared differently by ` +
            `"${existing.runtimeId}" and "${manifest.name}"; ` +
            `"${existing.runtimeId}" wins`,
        );
      }
    }
  }
  return [...merged.values()].map(({ command }) => command);
}

/** Build the only command directory a session client is allowed to execute. */
export function buildSessionCommandList(
  activePluginIds: readonly string[],
  pluginRegistry: PluginRegistry,
): SessionSlashCommand[] {
  const commands: SessionSlashCommand[] = [...FRAMEWORK_SLASH_COMMANDS];
  for (const pluginId of activePluginIds) {
    const entry = pluginRegistry.get(pluginId);
    if (!entry || entry.status === "error") continue;
    for (const command of mergePluginCommands(entry)) {
      commands.push({
        ...command,
        id: `${pluginId}:${command.name}`,
        pluginId,
        source: "plugin",
        sourceLabel: entry.summary.displayName ?? entry.summary.name,
      });
    }
  }
  return commands;
}

export function resolveSessionCommand(
  commandId: string,
  activePluginIds: readonly string[],
  pluginRegistry: PluginRegistry,
): SessionSlashCommand | undefined {
  return buildSessionCommandList(activePluginIds, pluginRegistry).find(
    (command) => command.id === commandId,
  );
}

export type SessionCommandParseResult =
  | { readonly ok: true; readonly invocation: RpcCommandInvocation }
  | Exclude<SlashCommandParseResult, { readonly ok: true }>;

/** Normalize composer text and JSON-render args into one handler contract. */
export function parseSessionCommandInvocation(
  command: SessionSlashCommand,
  request: PluginRpcCommandRequest,
  invocationId: string,
): SessionCommandParseResult {
  const parsed =
    typeof request.input === "string"
      ? parseSlashCommandInvocation(command, request.input)
      : parseStructuredSlashCommandInvocation(command, request.args);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    invocation: {
      ...parsed.invocation,
      invocationId,
      commandId: command.id,
      source: typeof request.input === "string" ? "composer" : "plugin-ui",
    },
  };
}

function hasScope(
  scopes: readonly SlashCommandContextScope[] | undefined,
  scope: SlashCommandContextScope,
): boolean {
  return scopes?.includes(scope) === true;
}

/**
 * Build an immutable, least-privilege command environment. Model ids are
 * resolved on the server; secrets, provider keys, prompts, and plugin data are
 * never included.
 */
export function buildCommandEnvironment(args: {
  readonly command: Pick<SessionSlashCommand, "context">;
  readonly session: SessionRecord;
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly resolveModel: (
    manifest: RuntimeManifest,
    apiOverride?: string,
  ) => string | undefined;
}): RpcCommandEnvironment | undefined {
  const scopes = args.command.context;
  if (!scopes || scopes.length === 0) return undefined;
  const includeModels = hasScope(scopes, "models");
  const includeRuntimes = includeModels || hasScope(scopes, "active-runtimes");

  return {
    capturedAt: new Date().toISOString(),
    ...(hasScope(scopes, "session")
      ? {
          session: {
            id: args.session.id,
            worldId: args.session.worldId,
            status: args.session.status,
            ...(args.session.phase ? { phase: args.session.phase } : {}),
            ...(args.session.locale ? { locale: args.session.locale } : {}),
          },
        }
      : {}),
    ...(includeRuntimes
      ? {
          activeRuntimes: args.activeRuntimes.map((runtime) => {
            const override = args.session.runtimeModelOverrides?.[runtime.name];
            const slot = override ?? runtime.model ?? "default";
            const resolved = includeModels
              ? args.resolveModel(runtime, override)
              : undefined;
            return {
              id: runtime.name,
              pluginId: runtime.pluginId,
              runtimeType: runtime.runtimeType ?? "agent",
              outputKind: runtime.outputKind ?? "plugin",
              ...(getRuntimeSpec(runtime).stage
                ? { stage: getRuntimeSpec(runtime).stage }
                : {}),
              capabilities: [...(runtime.capabilities ?? [])],
              ...(includeModels
                ? {
                    model: {
                      slot,
                      ...(resolved ? { resolved } : {}),
                      source: override
                        ? ("session-override" as const)
                        : runtime.model
                          ? ("manifest" as const)
                          : ("default" as const),
                    },
                  }
                : {}),
            };
          }),
        }
      : {}),
  };
}
