import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  defaultSessionSeats,
  type RuntimeManifest,
  type TurnInput,
  type LLMResponse,
} from "@covel/shared";
import { PluginServiceRegistry } from "../src/plugin-services.js";

export const input: TurnInput = {
  sessionId: "session",
  turnId: "turn",
  origin: "player",
  playerMessage: "Continue",
  locale: "en-US",
};
export const answer = (content = "The story continues."): LLMResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});
export function runtime(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    pluginId: name.split("/")[0]!,
    name,
    description: name,
    runtimeType: "function",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "auto" },
    maxRetries: 0,
    ...extra,
  };
}
export async function fixture(
  locale = "en-US",
): Promise<{ store: DataStore; services: PluginServiceRegistry }> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: input.sessionId,
    locale,
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["caller", "provider", "nested", "observer"],
    completedPlayerTurns: 0,
    seats: defaultSessionSeats(),
    createdAt: now,
    updatedAt: now,
  });
  const services = new PluginServiceRegistry({
    list: async () => ["caller", "provider", "nested", "observer"],
    ensure: async () => {},
  });
  return { store, services };
}
