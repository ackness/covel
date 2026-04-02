/**
 * @covel/plugin-test-utils
 *
 * Shared test utilities for plugin unit tests and live LLM integration tests.
 * Provides mock builders, live gateway setup, and assertion helpers.
 */

import { resolve } from "node:path";
import type { RuntimeContextView, ToolExecutionContext } from "@covel/shared";
import type {
  RuntimeHandlerContext,
  ContextProviderInput,
  PluginRegistrar,
  ContributionMap,
  ToolHandler,
  HookHandler,
  ContextProvider,
  RuntimeHandler,
  CommandRegistration,
} from "@covel/plugin-runtime";

// ── Mock RuntimeContextView ──────────────────────────────────────

const DEFAULT_CONTEXT_VIEW: RuntimeContextView = {
  run: {
    runId: "run_test_001",
    worldId: "world_test",
    branchId: "branch_main",
    turnId: "turn_001",
    status: "active",
    phase: "playing",
    defaultLocale: "zh-CN",
    activeBranchId: "branch_main",
  },
  locale: "zh-CN",
  world: {
    name: "测试世界",
    description: "一个用于测试的虚拟世界",
    characterSchema: {
      fields: ["name", "description", "personality", "background"],
    },
  },
  chat: [],
  characters: [],
  state: {},
  record: [],
  events: [],
  runtimeSettings: { flat: {}, byPlugin: {} },
  narrative: { content: "", messageId: "msg_001" },
  archive: { activeVersion: 1, latestVersion: 1, summary: "" },
  runtime: {
    runtimeId: "test-runtime",
    pluginId: "test-plugin",
    kind: "plugin",
    priority: 500,
    allowedTools: [],
    providerBinding: "fast",
    budget: { maxSteps: 5, timeoutMs: 30_000, maxTokens: 4096 },
  },
};

/** Create a mock RuntimeContextView with optional overrides. */
export function createMockContextView(
  overrides?: DeepPartial<RuntimeContextView>
): RuntimeContextView {
  return deepMerge(DEFAULT_CONTEXT_VIEW, overrides ?? {}) as RuntimeContextView;
}

// ── Mock RuntimeHandlerContext ───────────────────────────────────

/** Create a mock RuntimeHandlerContext for testing runtime handlers. */
export function createMockHandlerContext(
  overrides?: Partial<RuntimeHandlerContext> & {
    contextOverrides?: DeepPartial<RuntimeContextView>;
    generateTextImpl?: (prompt: string) => Promise<string>;
  }
): RuntimeHandlerContext {
  const {
    contextOverrides,
    generateTextImpl,
    ...directOverrides
  } = overrides ?? {};

  const ctx = createMockContextView(contextOverrides);

  return {
    runtimeId: ctx.runtime.runtimeId,
    pluginId: ctx.runtime.pluginId,
    locale: ctx.locale,
    context: ctx,
    instructions: undefined,
    data: undefined,
    generateText: generateTextImpl ?? (async (prompt: string) => `[mock response to: ${prompt.slice(0, 50)}...]`),
    ...directOverrides,
  };
}

// ── Mock ContextProviderInput ────────────────────────────────────

/** Create a mock ContextProviderInput. */
export function createMockProviderInput(
  overrides?: Partial<ContextProviderInput>
): ContextProviderInput {
  return {
    pluginId: "test-plugin",
    runtimeId: "test-runtime",
    locale: "zh-CN",
    state: {},
    world: { name: "测试世界" },
    characters: [],
    ...overrides,
  };
}

// ── Mock ToolExecutionContext ─────────────────────────────────────

/** Create a mock ToolExecutionContext. */
export function createMockToolContext(
  overrides?: Partial<ToolExecutionContext>
): ToolExecutionContext {
  return {
    toolId: "test-tool",
    pluginId: "test-plugin",
    runtimeId: "test-runtime",
    locale: "zh-CN",
    input: {},
    state: {},
    ...overrides,
  } as ToolExecutionContext;
}

// ── Collecting PluginRegistrar ───────────────────────────────────

/** Create a PluginRegistrar that collects all contributions into a map. */
export function createCollectingRegistrar(): {
  registrar: PluginRegistrar;
  contributions: ContributionMap;
} {
  const contributions: ContributionMap = {
    tools: new Map<string, ToolHandler>(),
    hooks: new Map<string, HookHandler>(),
    contextProviders: new Map<string, ContextProvider>(),
    runtimeHandlers: new Map<string, RuntimeHandler>(),
    commands: [],
  };

  const registrar: PluginRegistrar = {
    addTool(id: string, handler: ToolHandler) {
      contributions.tools.set(id, handler);
    },
    addHook(id: string, handler: HookHandler) {
      contributions.hooks.set(id, handler);
    },
    addContextProvider(id: string, handler: ContextProvider) {
      contributions.contextProviders.set(id, handler);
    },
    addRuntimeHandler(runtimeId: string, handler: RuntimeHandler) {
      contributions.runtimeHandlers.set(runtimeId, handler);
    },
    addCommand(registration: CommandRegistration) {
      contributions.commands.push(registration);
    },
  };

  return { registrar, contributions };
}

// ── Live LLM Gateway Setup ──────────────────────────────────────

/**
 * Create a real gateway connected to dashscope (qwen3.5-flash) for live tests.
 * Requires LIVE_LLM_ENABLED=1 and DASHSCOPE_API_KEY env vars.
 */
export async function createLiveGateway() {
  // Dynamic import to avoid hard dependency on ai-provider internals
  const { loadAiConfig } = await import("@covel/ai-provider");
  const { createProviderRegistry } = await import("@covel/ai-provider");
  const { createPresetRegistry } = await import("@covel/ai-provider");
  const { createGateway } = await import("@covel/ai-provider");

  const presetsPath = resolve(
    import.meta.dirname,
    "../../ai-provider/presets/default.toml"
  );
  const config = loadAiConfig(presetsPath);

  const providerRegistry = createProviderRegistry({
    providerDefaults: config.providers,
  });
  const presetRegistry = createPresetRegistry({
    profiles: config.profiles,
    presets: config.presets,
  });
  const gateway = createGateway({ providerRegistry, presetRegistry });

  const apiKeys: Record<string, string> = {};
  if (process.env.DASHSCOPE_API_KEY) {
    apiKeys.dashscope = process.env.DASHSCOPE_API_KEY;
  }

  return { gateway, apiKeys, presetId: "dashscope-qwen-flash" };
}

/**
 * Create a generateText function backed by live LLM for plugin handler testing.
 * Uses qwen3.5-flash via dashscope.
 */
export async function createLiveGenerateText(): Promise<
  (prompt: string) => Promise<string>
> {
  const { gateway, apiKeys, presetId } = await createLiveGateway();

  return async (prompt: string): Promise<string> => {
    const result = await gateway.generateText(
      {
        presetId,
        messages: [{ role: "user", content: prompt }],
      },
      { apiKeys }
    );
    return result.text;
  };
}

// ── Proposal Assertions ─────────────────────────────────────────

/** Assert that proposals contain exactly the expected kinds (order-insensitive). */
export function assertProposalKinds(
  proposals: Array<{ kind: string; payload: unknown }>,
  expectedKinds: string[]
): void {
  const actualKinds = proposals.map((p) => p.kind).sort();
  const expected = [...expectedKinds].sort();

  if (JSON.stringify(actualKinds) !== JSON.stringify(expected)) {
    throw new Error(
      `Proposal kinds mismatch.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actualKinds)}`
    );
  }
}

/** Assert that proposals contain at least the specified kinds. */
export function assertProposalContains(
  proposals: Array<{ kind: string; payload: unknown }>,
  requiredKinds: string[]
): void {
  const actualKinds = new Set(proposals.map((p) => p.kind));
  const missing = requiredKinds.filter((k) => !actualKinds.has(k));

  if (missing.length > 0) {
    throw new Error(
      `Missing proposal kinds: ${JSON.stringify(missing)}.\nActual: ${JSON.stringify([...actualKinds])}`
    );
  }
}

/** Find the first proposal of a given kind and return its payload. */
export function findProposal<T = unknown>(
  proposals: Array<{ kind: string; payload: unknown }>,
  kind: string
): T | undefined {
  const item = proposals.find((p) => p.kind === kind);
  return item?.payload as T | undefined;
}

/** Find all proposals of a given kind. */
export function findProposals<T = unknown>(
  proposals: Array<{ kind: string; payload: unknown }>,
  kind: string
): T[] {
  return proposals.filter((p) => p.kind === kind).map((p) => p.payload as T);
}

// ── Helpers ─────────────────────────────────────────────────────

export const LIVE = process.env.LIVE_LLM_ENABLED === "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

function deepMerge(target: unknown, source: unknown): unknown {
  if (
    typeof target !== "object" ||
    target === null ||
    typeof source !== "object" ||
    source === null
  ) {
    return source;
  }
  if (Array.isArray(source)) {
    return source;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key];
    if (key in result) {
      result[key] = deepMerge(result[key], srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}
