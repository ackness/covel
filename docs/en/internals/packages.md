# Package boundaries: who needs to know which library

This page explains what each library under `packages/` is responsible for, and who uses it. Read it first if you want to add a cross-package dependency to the framework, or if you are not sure which package a piece of code belongs in. People who write plugins only need to read the first row of the first table.

Covel is a modular monolith: one repository, released together, with its code split into several packages. Most packages in `packages/` are only boundaries inside the workspace and are not published on their own. To judge why a library exists, look at two things: what it is responsible for, and who calls it.

> [!IMPORTANT]
> The only library packaged for independent plugin authors is `@covel/plugin-handlers-utils`. It produces `dist` and type declaration files, and inside the workspace it is also read from this `dist`.
>
> So when the build output is older than the source (for example, you pulled new commits but did not run `pnpm install` again), a plugin that imports a new name will fail to load.
>
> - The development server checks and rebuilds it every time its process starts (`scripts/ensure-plugin-sdk.mjs`).
> - Turbo finishes the SDK build before running its own lint and tests. SDK tests read their own `dist` declarations through `shared`, so dependency-only `^build` ordering is not enough.
> - Before you run the tests of a single package on their own, you still have to run `pnpm --filter @covel/plugin-handlers-utils build` by hand.

The other libraries are mainly combined inside the workspace by the applications and the framework.

## Three usage paths

| User                                    | Entry points they should use                                                                                                                                                                                  | Implementation they do not need to touch                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin author                           | The public SDK types and helper functions of `@covel/plugin-handlers-utils`; the `PluginAPI`, `toolkit`, and the restricted `FunctionStoreView` that are injected at runtime                                  | The internal entry points of `runtime`, `store`, `tools`, and `shared`. `tools` depends on the SDK and implements the host-side tool registration and execution. The author defines tools through the injected `toolkit.tool`.    |
| Application host (server, desktop, web) | Combines `plugin-loader`, `runtime`, `store`, `memory`, `approval`, `events`, `context`, and others by their roles. Picks the actual backend, and provides resources, the session lock, and the commit policy | The business logic of plugin authors. A return value from an execution does not persist anything by itself. The host must commit the execution plan.                                                                              |
| Framework internals and dev tools       | The `shared` domain contracts, and the internal modules of each package. `plugin-test-utils` is for plugin unit tests, and `test-runtime` runs runtime cases in isolation                                     | Do not treat the test runner as a full HTTP server. It shares the default tools and the static tool approval policy with the server, but the store, LLM, event catalog, and other resources are provided by the test environment. |

The SDK for plugin authors and the implementation for the host are kept apart:

- `plugin-handlers-utils` does not depend on any private workspace package.
- `shared` holds the DTOs and schemas that the framework's layers share.
- `tools` implements the tool protocol that the SDK describes.

For details, see the [plugin contract](../reference/plugins.md) and [tools](../reference/tools.md).

## What each package is actually responsible for

| Package                 | Who needs to know it                                                                    | Reason to keep this boundary                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-handlers-utils` | Plugin authors, and host code that implements the author protocol                       | The only author SDK that can be packaged on its own. It owns `PluginAPI`, the handler and context, proposals, explicit tool results, and the contracts for helper functions.                                                                                                                                                                                                                                               |
| `shared`                | Framework packages and applications                                                     | The owner of the types shared by the Covel domain records, events, schemas, and cross-layer protocols. It is not a second SDK for plugin authors.                                                                                                                                                                                                                                                                          |
| `plugin-loader`         | The server, and development and test tools                                              | Discovers, validates, and loads plugin packages from the Node file system. It keeps a single implementation of the plugin directory and manifest protocol.                                                                                                                                                                                                                                                                 |
| `runtime`               | The server and `test-runtime`                                                           | Scheduling, execution, suspend and resume, effect commits, and the lifecycle together form the Covel kernel. The host connects to persistence through its execution and commit APIs.                                                                                                                                                                                                                                       |
| `tools`                 | The server, `runtime`, and `test-runtime`                                               | Host-side tool definition validation, registration, execution, and assembly of the built-in tools. It depends on the author SDK's tool result contract. The default built-in set is built by `createDefaultToolRegistry`.                                                                                                                                                                                                  |
| `approval`              | The server, `runtime`, and `test-runtime`                                               | Two different authorization mechanisms share one small package. `createDefaultToolApprovalPipeline` is the static allow/deny policy by tool source. `createRpcApprovalGate` is the interactive Plugin RPC authorization state, scoped to a session. The first does not save player approvals. For the second, the host handles the HTTP decision flow.                                                                     |
| `context`               | `runtime`, and the server's compaction and generation flows                             | Assembles the prompt, history, injected plugin data, and the token budget. The common entry is only the asynchronous `await buildContext(params)`, which decides on its own, based on its inputs, whether to read the store. Independent prompt directories are injected with `createPromptLoader(root)`.                                                                                                                  |
| `events`                | The server's subscription layer, `runtime`, and the plugin registration flow            | The Covel event bus, replay, optional persistence, and the transport interface. The internal RingBuffer is not part of the API for consumers.                                                                                                                                                                                                                                                                              |
| `store`                 | The server, `runtime`, `memory`, and browser sync                                       | The domain persistence contract and the Memory/SQLite/PostgreSQL backends (`/indexeddb` provides only the browser-side media cache). The root entry holds the contract, the factories, and operations that work across backends. Concrete backend factories are imported from `/memory`, `/sqlite`, `/postgres`, and `/indexeddb`. Browser sync and vector features have their own sub-entries.                            |
| `memory`                | Assembled by the server. `runtime` uses it through injected interfaces                  | Recall, archival, BM25 and vector retrieval, and incremental indexing. When no embedding model is configured, everything uses BM25. The ranking implementation comes from `rankTexts` in `plugin-handlers-utils`, and plugins use the same one. Each `createMemorySystem` instance owns its own set of background tasks, `pendingTaskCount()`, and `drain()`. After the host stops the producers, it drains that instance. |
| `ai-provider`           | The server's model configuration, the runtime gateway, and the `test-runtime` live mode | Centralized adapters for model selection, provider protocols, and media wires. Concrete providers do not enter the plugin author API.                                                                                                                                                                                                                                                                                      |
| `create`                | The server's world generation routes                                                    | World content generation and validation with an injectable LLM. Explicit `writeWorldPackage` exports files. Database consumers use the generated results directly.                                                                                                                                                                                                                                                         |
| `settings`              | The web settings panel and the persistence adapter                                      | The abstraction for registering, validating, subscribing to, and persisting settings. The host provides the actual IPC/HTTP transport.                                                                                                                                                                                                                                                                                     |
| `plugin-test-utils`     | Plugin unit and integration tests                                                       | A restricted context, mocks, and the entry point for tool integration tests that reuse the real execution and transaction commit. It does not start a full HTTP server.                                                                                                                                                                                                                                                    |
| `test-runtime`          | Plugin developers running runtime cases                                                 | A development CLI that calls the real runtime with an isolated store and a mock or live gateway. It reuses the default tool set and the static approval policy, but it does not cover HTTP routes, the production event catalog, or deployment locks.                                                                                                                                                                      |

The small packages `approval`, `context`, `events`, `create`, and `settings` each have clear users and their own responsibilities.

- Do not merge a package into `runtime` just because it is small or only used during development.
- Also do not add a package that only forwards calls just to look generic.

**Dependency direction.** `plugin-handlers-utils` is the root of the dependency graph, and it does not depend on any workspace package. `shared` sits directly above it. `@covel/server` composes all feature packages. The exact dependency edges are written in each package's `package.json`. `pnpm check:boundaries` checks the public entry points and the dependency direction. The `store` package declares the SQLite vector extension `sqlite-vec` directly; the root package does not duplicate it.

## Key boundaries when the host combines packages

The host is an application that assembles these packages and runs them: the server, the desktop app, and the web app.

### Two separate sites

- The official website `apps/site` is a separate static site. It does not depend on any workspace package, and it is not part of the Web or desktop build.
- The docs site `apps/docs` is also separate. It uses VitePress to build the pages of `docs/` into a static site, which is published under the `docs/` path of the official website.
- The application's own `/` goes straight to the world list.

### Desktop shell

The desktop shell depends on Zod directly to validate the window state saved locally. The window position and size belong to the Electron host. They are not exposed as a shared domain schema.

### After execution, you must commit

An execution first gets `{ result, commit }` from `executeTurn(...)` or `resumeSuspendedRuntime(...)`:

| Field    | What it is                                           | Notes                                                                                                                                |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `result` | The business result that can be passed to the client | The `pendingProposals` of the runtime results at every layer have been removed. Only business data remains in `RuntimeResult.output` |
| `commit` | The commit plan handed only to the host              | Contains the top-level and recursive results, the journal, suspensions, hook scope, schema, setup, and clock information             |

Buffered writes are kept in `commit.results[].pendingProposals`, not hidden on the output. The host commits this plan inside the session lock. It does not need to assemble these internal data itself:

```ts
const execution = await executeTurn(input, manifests, deps);
const { result } = execution;
await commitExecution({
  execution,
  store: deps.store,
  completion: {
    kind: "turn",
    turnId: result.turnId,
    durationMs: result.durationMs,
  },
});
```

- Resumed executions also pass the whole `execution` to `commitExecution`. The completion policy uses `kind: "resume"`.
- The commit transaction, and the notifications, snapshots, and memory scheduling after the commit, each follow the [transaction contract](../reference/transactions.md).

> [!WARNING]
> A successful tool call does not mean that the proposal has been saved. It is saved only when the commit succeeds.

### What the server and the test runner share

Both the server and `test-runtime` use `createDefaultToolRegistry({ store, eventDirectory })` and `createDefaultToolApprovalPipeline()`. So the names of the default tools and their source policy are the same. The difference is in the resources:

| Host           | What it injects                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| server         | The actual event schema, character capabilities, persistence resources, and interactive RPC approval |
| `test-runtime` | Isolated resources and a mock gateway                                                                |

When a tool returns `{ kind: "covel.tool-result", content, pendingProposals, emittedEvents? }`, the host first separates and validates the effects in it, and then hands the content to the model. A pure tool that produces no effects can return its content directly. For details, see the [tool contract](../reference/tools.md).

### memory and create

- The unified `search` entry point of memory handles reusing the query embedding and ranking across sources. Tools only convert the results into a display form.
- `createWorld` returns validated, portable content. `writeWorldPackage` handles the optional file export. The database and the "return only" mode use the generated result directly.
- The memory background queue belongs to each `MemorySystem` instance. It is not a process-wide global queue.
- The cursor and content hash of incremental vector indexing are saved in a dedicated `vector_index_progress` table. It is derived index state that can be rebuilt, and it does not take up the plugin data namespace.
- memory uses the store's narrow capability interfaces. The server chooses the embedding, the cross-process lock, the recovery tasks, and the drain policy on shutdown.

For details, see [transactions](../reference/transactions.md) and [world data](../reference/world-data.md).

### The prompt loader of context

The prompt loader is also split by instance:

- The shared templates use the default `loadPrompt`.
- A plugin's own directory is injected through `createPromptLoader(root)`.
- The public entry of the package does not export the process-wide `setPromptsRoot`.
- `buildContext` always returns a Promise. The caller does not need to decide in advance whether a synchronous or asynchronous path is used.

For details, see [prompt structure](../reference/prompt-structure.md).

### What is in the author SDK

The standalone plugin SDK owns these implementations. The host packages only re-export the same ones:

- Locale resolution, token estimation, and the validation and instantiation of dimensions. `@covel/shared` re-exports these definitions.
- Dimension providers import from `@covel/plugin-handlers-utils/dimensions`. Plugins do not go into the shared package to get these operations.
- The UI tool factories and the character field validation are also in the SDK.
- Reading files by locale is placed in the `/prompts` entry, which can be used only in Node. The root entry stays usable in the browser.
- What the host packages re-export includes the error class of tool validation.

## Compatibility scope during development

Covel is still in early development, and it targets only the current contracts. When a contract changes, the producers and consumers change together. Old entry points are not kept as aliases, and nothing is written twice. The current rules are:

- Authors use the packageable SDK.
- Concrete store backends are imported from their sub-entries.
- Callers of context must write `await buildContext`.
- The host must keep and commit the execution plan.
- Tool effects must be passed through explicit results and `pendingProposals`.
- Test fixtures and plugin code are updated under the same rules.

> [!WARNING]
> These libraries currently make no promise of a persistence migration across versions. When the store schema or the vector progress table changes, the affected development data must be created again. Do not treat "old data can still be read" or "old entry points still work" as a guarantee.

`pnpm check:boundaries` checks three things in the production source: the public entry points of the workspace, the dependency declarations, and the direction of the packages. When a new cross-package dependency is needed, review it together with the responsibility split on this page.
