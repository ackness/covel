/**
 * TestHarness — one-call setup for plugin integration testing.
 *
 * Discovers plugins, creates in-memory store, wires up tool executor,
 * and provides a simple `executeTurn()` method.
 */

import type { TurnInput, TurnResult, RuntimeManifest } from '@covel/shared';
import type { LLMAdapter } from '@covel/runtime';
import type { HookPipeline } from '@covel/runtime';
import type { DataStore } from '@covel/store';
import type { ToolModule } from '@covel/tools';
import { discoverPlugins, loadPluginManifest, loadRuntime } from '@covel/plugin-loader';
import type { LoadedRuntime } from '@covel/plugin-loader';
import { executeTurn, createToolExecutor } from '@covel/runtime';
import type { TurnExecutorDeps } from '@covel/runtime';
import { createMemoryStore } from '@covel/store';
import { builtinUITools } from '@covel/tools';
import { MockLLM } from './mock-llm.js';

export interface TestHarnessConfig {
  /** Path to the plugins directory. */
  readonly pluginsDir: string;
  /** Optional custom LLM adapter (defaults to MockLLM with empty response). */
  readonly llm?: LLMAdapter;
  /** Additional tools to register alongside builtins. */
  readonly tools?: readonly ToolModule[];
  /** Plugin IDs to activate (defaults to all discovered). */
  readonly activePlugins?: readonly string[];
  /** Optional hook pipeline to inject into turn execution (e.g. for testing global hooks). */
  readonly hookPipeline?: HookPipeline;
}

export interface TestHarness {
  /** Execute a turn with the given player message. */
  readonly executeTurn: (message: string, overrides?: Partial<TurnInput>) => Promise<TurnResult>;
  /** The in-memory store backing this harness. */
  readonly store: DataStore;
  /** Discovered runtime manifests (sorted by priority). */
  readonly manifests: readonly RuntimeManifest[];
  /** The LLM adapter in use (for inspection/assertion). */
  readonly llm: LLMAdapter;
}

/**
 * Create a fully-wired test harness for plugin integration testing.
 *
 * Discovers plugins from the filesystem, creates an in-memory store,
 * registers tools, and returns a harness with a simple `executeTurn()` method.
 *
 * @param config - Harness configuration: plugins directory, optional LLM adapter, extra tools, and active plugin filter.
 * @returns A `TestHarness` with an in-memory store, discovered manifests, and a ready-to-use `executeTurn` method.
 *
 * @example
 * ```typescript
 * import { createTestHarness } from '@covel/plugin-test-utils';
 * import { MockLLM } from '@covel/plugin-test-utils';
 *
 * const harness = await createTestHarness({
 *   pluginsDir: './plugins',
 *   llm: new MockLLM({ defaultResponse: { content: 'Hello!', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } }),
 *   activePlugins: ['core-narrator'],
 * });
 *
 * const result = await harness.executeTurn('Start the adventure');
 * console.log(result.runtimeResults);
 * ```
 */
export async function createTestHarness(
  config: TestHarnessConfig,
): Promise<TestHarness> {
  const store = createMemoryStore();
  const llm = config.llm ?? new MockLLM();

  // Discover and load plugins
  const discoveries = await discoverPlugins(config.pluginsDir);
  const allManifests: RuntimeManifest[] = [];
  const loadedCache = new Map<string, LoadedRuntime>();

  for (const discovery of discoveries) {
    if (config.activePlugins && !config.activePlugins.includes(discovery.id)) {
      continue;
    }
    const parsed = await loadPluginManifest(discovery);
    for (const p of parsed) {
      allManifests.push(p.manifest);
      const loaded = await loadRuntime(discovery, p.manifest.name);
      loadedCache.set(p.manifest.name, loaded);
    }
  }

  // Sort by priority
  allManifests.sort((a, b) => a.priority - b.priority);

  // Build tool map
  const toolMap = new Map<string, ToolModule>();
  for (const t of builtinUITools) {
    toolMap.set(t.name, t);
  }
  for (const t of config.tools ?? []) {
    toolMap.set(t.name, t);
  }

  const toolExecutor = createToolExecutor({
    findTool: (name) => toolMap.get(name),
    store,
  });

  let turnCount = 0;

  const harness: TestHarness = {
    store,
    manifests: allManifests,
    llm,
    executeTurn: async (message: string, overrides?: Partial<TurnInput>) => {
      turnCount++;
      const turnInput: TurnInput = {
        sessionId: 'sess-harness',
        turnId: `turn-${turnCount}`,
        playerMessage: message,
        ...overrides,
      };

      const deps: TurnExecutorDeps = {
        loadRuntime: async (manifest) => loadedCache.get(manifest.name),
        llm,
        getConfig: () => ({}),
        store,
        toolExecutor,
        hookPipeline: config.hookPipeline,
      };

      return executeTurn(turnInput, allManifests, deps);
    },
  };

  return harness;
}
