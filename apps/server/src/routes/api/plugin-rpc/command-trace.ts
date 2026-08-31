import type { EventBus } from "@covel/events";
import { createTurnEmitter, type TurnEmitterStore } from "@covel/runtime";
import type { RpcCommandInvocation, SessionSlashCommand } from "@covel/shared";

interface RunTracedCommandArgs<T> {
  readonly store: TurnEmitterStore;
  readonly eventBus?: EventBus;
  readonly sessionId: string;
  readonly command: SessionSlashCommand;
  readonly invocation: RpcCommandInvocation;
  readonly dispatch: () => Promise<T>;
}

function commandTracePayload(
  command: SessionSlashCommand,
  invocation: RpcCommandInvocation,
): Record<string, unknown> {
  return {
    invocationId: invocation.invocationId,
    commandId: invocation.commandId,
    command: invocation.command,
    pluginId: command.pluginId,
    action: command.action,
    source: invocation.source,
    canonical: invocation.canonical,
    raw: invocation.raw,
    argv: invocation.argv,
    args: invocation.args,
  };
}

/** Run one canonical command and persist its lifecycle under one trace id. */
export async function runTracedCommand<T>(
  args: RunTracedCommandArgs<T>,
): Promise<T> {
  const emitter = createTurnEmitter({
    store: args.store,
    eventBus: args.eventBus,
    sessionId: args.sessionId,
    turnId: args.invocation.invocationId,
    traceId: args.invocation.invocationId,
  });
  const base = commandTracePayload(args.command, args.invocation);
  const startedAt = performance.now();
  await emitter.emit("command.invoked", base);
  try {
    const result = await args.dispatch();
    const commandResult =
      result && typeof result === "object" && "result" in result
        ? (result as { readonly result?: unknown }).result
        : undefined;
    const resultOk =
      commandResult && typeof commandResult === "object"
        ? (commandResult as { readonly ok?: unknown }).ok
        : undefined;
    await emitter.emit("command.completed", {
      ...base,
      durationMs: Math.max(0, performance.now() - startedAt),
      ...(typeof resultOk === "boolean" ? { resultOk } : {}),
    });
    return result;
  } catch (error) {
    await emitter.emit("command.failed", {
      ...base,
      durationMs: Math.max(0, performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
