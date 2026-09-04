import type { PluginRpcStructuredCommandRequest } from "@covel/shared";

export interface PluginCommandBuildSuccess {
  readonly ok: true;
  readonly command: string;
  readonly request: PluginRpcStructuredCommandRequest;
}

export interface PluginCommandBuildFailure {
  readonly ok: false;
  readonly error: string;
}

/** Bind a JSON-render command name to the plugin that owns the rendered spec. */
export function buildPluginCommandRequest(
  pluginId: string,
  params: Readonly<Record<string, unknown>>,
): PluginCommandBuildSuccess | PluginCommandBuildFailure {
  const command =
    typeof params.command === "string" ? params.command.trim() : "";
  if (!/^[a-z][a-z0-9-]*$/u.test(command)) {
    return {
      ok: false,
      error: "invokeCommand requires a canonical lowercase command name",
    };
  }
  const rawArgs = params.args ?? {};
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { ok: false, error: "invokeCommand params.args must be an object" };
  }
  return {
    ok: true,
    command,
    request: {
      kind: "command",
      commandId: `${pluginId}:${command}`,
      args: rawArgs as Readonly<Record<string, unknown>>,
    },
  };
}
