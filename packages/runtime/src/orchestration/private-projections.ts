import {
  CHARACTER_ACTOR_CONTRACT,
  characterActorOutputSchema,
  concealTracePayload,
  type RuntimeManifest,
  type ToolCallRecord,
} from "@covel/shared";
import {
  DELEGATE_TOOL_NAME,
  delegateParametersSchema,
  parseJsonText,
} from "@covel/tools";
import type { TurnEmitter } from "../trace/turn-emitter.js";

/** Kernel-owned call provenance; the live transcript is never edited. */
export class PrivateDelegationProjection {
  readonly calls: Set<string>;
  readonly concealedCalls: Set<string>;
  constructor(
    ids: readonly string[] = [],
    concealedIds: readonly string[] = [],
  ) {
    this.calls = new Set(ids);
    this.concealedCalls = new Set(concealedIds);
  }
  mark(id: string, kind: "actor" | "concealed"): void {
    this.calls.add(id);
    if (kind === "concealed") this.concealedCalls.add(id);
  }
  completion(
    id: string,
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.calls.has(id)) return value;
    if (this.concealedCalls.has(id)) return {};
    const actor = characterActorOutputSchema.safeParse(value);
    return actor.success ? { segments: actor.data.segments } : {};
  }
  record(call: ToolCallRecord): ToolCallRecord {
    return this.calls.has(call.toolCallId)
      ? { ...call, input: null, output: null }
      : call;
  }
  emitter(
    inner: TurnEmitter | undefined,
    runtimes: readonly RuntimeManifest[],
  ): TurnEmitter | undefined {
    if (!inner) return undefined;
    const privateProviders = runtimes.filter(
      (runtime) =>
        runtime.concealed ||
        runtime.outputContract === CHARACTER_ACTOR_CONTRACT,
    );
    const privateRuntimeIds = new Set(
      privateProviders.map((runtime) => runtime.name),
    );
    const learn = (value: unknown, callerPluginId: unknown) => {
      if (!value || typeof value !== "object") return;
      const call = value as {
        id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (
        call.name !== DELEGATE_TOOL_NAME ||
        typeof call.id !== "string" ||
        typeof call.arguments !== "string"
      )
        return;
      try {
        const args: unknown = parseJsonText(call.arguments);
        if (!args || typeof args !== "object") return;
        // A known private target stays private even when other arguments fail.
        const parsed = delegateParametersSchema.shape.target.safeParse(
          (args as { target?: unknown }).target,
        );
        if (!parsed.success) return;
        const target = parsed.data;
        const providers = privateProviders.filter((provider) =>
          "contract" in target
            ? provider.outputContract === target.contract
            : provider.name === target.runtimeId &&
              provider.pluginId === callerPluginId,
        );
        if (providers.length)
          this.mark(
            call.id,
            providers.some((provider) => provider.concealed)
              ? "concealed"
              : "actor",
          );
      } catch {
        /* Invalid JSON has no resolved provider. */
      }
    };
    const projectMessage = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      const message = value as Record<string, unknown>;
      const privateResult =
        typeof message.toolCallId === "string" &&
        this.calls.has(message.toolCallId);
      const toolCalls = Array.isArray(message.toolCalls)
        ? message.toolCalls.map((value: unknown) => {
            if (!value || typeof value !== "object") return value;
            const call = value as Record<string, unknown>;
            return typeof call.id === "string" && this.calls.has(call.id)
              ? { ...call, arguments: "{}" }
              : call;
          })
        : undefined;
      return {
        ...message,
        ...(privateResult ? { content: "[Private delegation result]" } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      };
    };
    return {
      ...inner,
      emit: async (type, payload) => {
        if (Array.isArray(payload.toolCalls))
          for (const call of payload.toolCalls) learn(call, payload.pluginId);
        if (
          typeof payload.runtimeId === "string" &&
          privateRuntimeIds.has(payload.runtimeId)
        )
          return inner.emit(type, concealTracePayload(payload));
        if (
          typeof payload.toolCallId === "string" &&
          this.calls.has(payload.toolCallId)
        )
          return inner.emit(type, concealTracePayload(payload));
        const copy = projectMessage(payload) as Record<string, unknown>;
        if (Array.isArray(payload.messages))
          copy.messages = payload.messages.map(projectMessage);
        if (this.calls.size) {
          // Provider wire bodies and reasoning can duplicate private tool messages.
          delete copy.providerRequests;
          delete copy.reasoningContent;
          delete copy.diagnostics;
        }
        await inner.emit(type, copy);
      },
    };
  }
}
