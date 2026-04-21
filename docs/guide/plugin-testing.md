# Plugin Testing

Covel ships three layers of test tooling for plugin authors: `@covel/plugin-test-utils` for fast in-process assertions (MockLLM + an in-memory harness + factories), Vitest for the package-local unit tests every plugin should have, and `scripts/e2e-plugin-verify.ts` for API-driven end-to-end runs against a real server. Reach for the harness when you want to assert what a runtime produced given a mocked LLM; reach for the E2E script when the thing you care about only shows up after the full SSE/store/approval pipeline has run. Nothing below requires a live provider key.

> Chinese translations welcome.

See also: [docs/guide/plugin-authoring.md](./plugin-authoring.md) · [docs/guide/e2e-plugin-verify.md](./e2e-plugin-verify.md).

## Quick start

Install nothing — `@covel/plugin-test-utils` is already a workspace package. Create a test file next to your plugin (or under `plugins/<your-plugin>/tests/`), import the utilities, and wire them up:

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MockLLM,
  createTestHarness,
  makeTurnInput,
} from '@covel/plugin-test-utils';

const PLUGINS_DIR = path.resolve(import.meta.dirname, '../../../plugins');

describe('my-plugin', () => {
  it('runs a turn end-to-end', async () => {
    const llm = new MockLLM({
      defaultResponse: {
        content: 'You step into the cavern.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });

    const harness = await createTestHarness({
      pluginsDir: PLUGINS_DIR,
      activePlugins: ['my-plugin'],
      llm,
    });

    const result = await harness.executeTurn('look around');

    expect(result.runtimeResults[0].status).toBe('success');
    expect(llm.calls).toHaveLength(1);
  });
});
```

What the harness gives you:

| Field | Use |
|-------|-----|
| `harness.executeTurn(message, overrides?)` | Runs one full turn through the runtime pipeline with `@covel/runtime`'s `executeTurn`. |
| `harness.store` | In-memory `DataStore` — inspect `plugin_data`, proposals, session state. |
| `harness.manifests` | Discovered runtime manifests, priority-sorted. |
| `harness.llm` | The adapter you passed in (defaults to a blank `MockLLM`). |

Factories (`makeTurnInput`, `makeTriggerContext`, `makeRuntimeResult`) fill required fields with sensible defaults so unit tests aren't littered with boilerplate.

## Five real-world examples

### 1. Assert a plugin emits a specific proposal

```ts
import { describe, it, expect } from 'vitest';
import { MockLLM, createTestHarness } from '@covel/plugin-test-utils';

it('narrator emits a narrative.append proposal', async () => {
  const llm = new MockLLM({
    defaultResponse: {
      content: 'The wind picks up.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 12 },
    },
  });

  const harness = await createTestHarness({
    pluginsDir: PLUGINS_DIR,
    activePlugins: ['core-narrator'],
    llm,
  });

  const result = await harness.executeTurn('continue');

  const narrativeProposals = result.runtimeResults
    .flatMap((r) => r.proposals ?? [])
    .filter((p) => p.type === 'narrative.append');

  expect(narrativeProposals).toHaveLength(1);
  expect(narrativeProposals[0].payload.text).toContain('wind');
});
```

### 2. Assert a tool is called in a specific order

`MockLLM` records each `generate()` invocation. Stage a scripted response sequence by extending `MockLLM` (recommended when order matters) or by re-binding `defaultResponse` between calls. The simplest pattern is a counter-driven subclass:

```ts
class ScriptedLLM extends MockLLM {
  private step = 0;
  constructor(private readonly script: LLMResponse[]) {
    super();
  }
  async generate(params: Parameters<MockLLM['generate']>[0]) {
    this.calls.push({ messages: params.messages });
    const next = this.script[this.step] ?? this.defaultResponse;
    this.step++;
    return next;
  }
}

it('calls plugin-data-set before create-character', async () => {
  const llm = new ScriptedLLM([
    {
      content: null,
      toolCalls: [{ id: '1', name: 'plugin-data-set', arguments: '{"key":"stage","value":"intro"}' }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 80, outputTokens: 10 },
    },
    {
      content: null,
      toolCalls: [{ id: '2', name: 'create-character', arguments: '{"name":"Kai"}' }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 110, outputTokens: 14 },
    },
    {
      content: 'Done.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 120, outputTokens: 5 },
    },
  ]);

  const harness = await createTestHarness({
    pluginsDir: PLUGINS_DIR,
    activePlugins: ['my-plugin'],
    llm,
  });

  const result = await harness.executeTurn('begin onboarding');
  const toolNames = result.runtimeResults[0].toolCalls.map((c) => c.name);

  expect(toolNames).toEqual(['plugin-data-set', 'create-character']);
});
```

### 3. Assert plugin_data.set happens with the expected key

```ts
it('persists the current stage to plugin_data', async () => {
  const harness = await createTestHarness({
    pluginsDir: PLUGINS_DIR,
    activePlugins: ['my-plugin'],
    llm: new MockLLM({
      defaultResponse: {
        content: null,
        toolCalls: [
          { id: 't1', name: 'plugin-data-set', arguments: '{"namespace":"progress","key":"stage","value":"act-2"}' },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 60, outputTokens: 8 },
      },
    }),
  });

  await harness.executeTurn('continue');

  const entries = await harness.store.listPluginData(
    'sess-harness',
    'my-plugin',
    'progress',
  );

  expect(entries).toHaveLength(1);
  expect(entries[0].key).toBe('stage');
  expect(entries[0].value).toBe('act-2');
});
```

Read back with `store.getPluginData(sessionId, pluginId, namespace, key)` when you want a single entry.

### 4. Test trigger behaviour (scheduled / interval)

Triggers are pure functions — you do not need the harness to exercise them. Import the runtime's `shouldTrigger` (or replicate the manifest check) and feed it `makeTriggerContext(...)`.

```ts
import { makeTriggerContext } from '@covel/plugin-test-utils';
import { shouldRunOnInterval } from '../src/trigger.js';

it('fires every 3 turns starting at turn 1', () => {
  expect(shouldRunOnInterval(makeTriggerContext({ turnNumber: 1 }))).toBe(true);
  expect(shouldRunOnInterval(makeTriggerContext({ turnNumber: 2 }))).toBe(false);
  expect(shouldRunOnInterval(makeTriggerContext({ turnNumber: 3 }))).toBe(false);
  expect(shouldRunOnInterval(makeTriggerContext({ turnNumber: 4 }))).toBe(true);
});
```

If your trigger consumes `turnsSinceLastTrigger`, set it explicitly in the override. `makeTriggerContext` defaults to `999` so most "cooldown elapsed" branches fire on the first assertion.

### 5. Snapshot the runtime output

Snapshots are useful when a runtime emits a large structured JSON blob (e.g. a codex entry list) and you want regression coverage without handwriting every assertion.

```ts
it('matches the codex snapshot', async () => {
  const harness = await createTestHarness({
    pluginsDir: PLUGINS_DIR,
    activePlugins: ['core-codex'],
    llm: new MockLLM({
      defaultResponse: {
        content: null,
        toolCalls: [
          { id: 'c1', name: 'codex-upsert', arguments: '{"entries":[{"key":"dragon","title":"Dragon","category":"monster"}]}' },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 200, outputTokens: 40 },
      },
    }),
  });

  await harness.executeTurn('a dragon appears');

  const entries = await harness.store.listPluginData(
    'sess-harness',
    'core-codex',
    'entries',
  );

  expect(entries.map((e) => ({ key: e.key, value: e.value }))).toMatchSnapshot();
});
```

Vitest writes the snapshot to `__snapshots__/` next to the test file. Delete and re-run to refresh after intentional changes.

## Running tests

Run a single package's tests (watch mode is the default in the absence of `--run`):

```bash
pnpm --filter @covel/runtime test           # watch
pnpm --filter @covel/runtime test -- --run  # one shot
pnpm --filter my-plugin test                # any plugin with its own test script
```

Whole-workspace run (cached by Turbo):

```bash
pnpm test             # vitest via turbo
pnpm test:coverage    # + @vitest/coverage-v8
```

### Unit tests vs `e2e-plugin-verify`

| Tool | When |
|------|------|
| `@covel/plugin-test-utils` + Vitest | You can mock the LLM response deterministically and only need to assert what the runtime produced (proposals, tool calls, plugin_data writes). Milliseconds per test, no server, no API keys. |
| `scripts/e2e-plugin-verify.ts` | The behaviour you care about only shows up after the HTTP pipeline (SSE, session kernel, approval policy, store) has run. Needs a live server (`pnpm dev:server`) and a slot in `llm.toml` — `llmock` is fine. |

The E2E script is documented at [docs/guide/e2e-plugin-verify.md](./e2e-plugin-verify.md). Artifacts land under `debugs/e2e-logs/<run-id>/`.

## Tips

- The harness sorts manifests by priority. If a runtime with a lower priority than yours writes to the same `plugin_data` namespace, account for it by filtering on `pluginId` when reading back.
- `MockLLM.calls[n].messages` is the raw assembled prompt. Snapshot it when you want to regression-test prompt assembly — but expect high churn if you also touch `prompts/`.
- `activePlugins` narrows the discovery list. Leave it off to load everything under `plugins/` (useful for cross-plugin integration tests) or set it to `[]` to load nothing.
- Use real plugin IDs as test fixtures; production framework code must not (see CLAUDE.md "Framework ↔ Plugin Isolation Rule").
