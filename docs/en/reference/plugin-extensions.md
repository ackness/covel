# Plugin extension boundaries and communication

A plugin rarely works alone. It may need to read a result that another plugin computed, emit an event, call another plugin's function, or draw its own panel in the interface. This page explains which interface to use for each of these jobs and where the boundary of each one is. Plugin authors who write several plugins that work together, connect a new model protocol, or build a custom UI need it.

The split of work is this: the framework handles discovery, authorization, scheduling, validation, cancellation, and mounting. The structure of business data, the algorithms, the provider protocols, and the UI components stay inside the plugin package.

Examples you can install and look at:

- [Lifecycle Probe](../../../tests/third-party/lifecycle-probe/README.md) and [Service Provider Probe](../../../tests/third-party/service-provider-probe/README.md): two plugins you can install on their own. Together they cover commands, panels, manual functions, data submission, and service collaboration.
- [Jev choice recommendation demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo).

## Choose a way to communicate

Start by finding your need in the table and reading the matching interface:

| Need                                                    | Interface                                                                                       | Execution and data boundary                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use an upstream result from this turn                   | `runtime.io.inputs` + `accepts`                                                                 | Binds to a versioned contract or runtime, creates a scheduling dependency, and carries the source. If a required input is missing, the runtime is skipped.         |
| Use a committed past result                             | `runtime.io.output.recordAs` + `io.inputs` with `scope: committed`                              | Reads a snapshot taken before this execution starts.                                                                                                               |
| Emit an event and trigger later work                    | Event results from a handler / the `emit-event` tool + an event trigger                         | Managed by scheduling and the commit path. It is not a free broadcast in memory.                                                                                   |
| Call another plugin's public function or model protocol | `covel.registerService` + `ctx.services` / a tool's `context.services` / `agent.tools.services` | Request and response. Input and output are validated. Only active services that are allowed to run can be called. An agent imports model-facing services as tools. |
| Have another agent answer a brief                       | A `schedule.subagentOnly` provider + `ctx.agents.run` / the `delegate` tool                     | A [sub-agent](./plugins.md#sub-agents) runs inside the caller's execution and returns output only, with no writes; a contract finds a provider in another package  |
| Write domain data from a runtime                        | Declared tools, handler effects / `ctx.pluginData`                                              | Goes through the runtime's proposal and commit boundary. It does not write to another plugin directly.                                                             |
| A UI action runs the plugin's own server logic          | `invokeRuntime` / `invokePluginAction` / `invokeCommand`                                        | Reuses the existing RPC, session ownership, and approval. For write boundaries, see below.                                                                         |
| A UI emits a domain event                               | `emitEvent`                                                                                     | Can emit only topics that the plugin declares, checked against a schema. Subscribed runtimes run as event tasks.                                                   |
| Draw a custom UI                                        | JSON `view` or HTML `webview`                                                                   | HTML runs in a separate sandbox. It reads data and sends actions through a message bridge.                                                                         |

The details that do not fit in the table come next.

A function runtime that changes its own data can submit a list of operations instead of a computed whole value: `ctx.pluginData.update(namespace, key, ops)` produces `plugin.data.update`, which applies to the latest value at commit (see [Transactions · Operation-based writes](./transactions.md#operation-based-writes-plugindataupdate)). This belongs only to the runtime write boundary: `ctx.pluginData` is read-only in both extension and service handlers.

`ctx.recursiveCall` is for [nested calls within one package](./plugins.md#nested-calls-ctxrecursivecall). Use a service to request a result from another package, or an event to trigger its follow-up work.

The session's seats (who is playing and which characters they control) belong to no plugin, so you never ask another plugin for them through a service or an input. Function runtimes, guards, tools (`context.world`) and extension providers (`ctx.world`) all read the same read-only copy on `world.seats`. Derive the character the player acts as with the SDK's `primarySeat`, `currentCharacterOf` and `seatCharacterIds`; the rules are in [Seats](./world-model.md#seats). Plugins cannot write seats; the player switches the current character through the [switch endpoint](./api.md#session-seats).

<a id="services-are-only-for-function-runtimes"></a>

### How tools and agents use services

- Function runtime handlers and agent guards use `ctx.services`.
- Plugin tools use `context.services`, with the same rules as a function runtime: the caller is the tool's plugin and runtime, a call inherits the tool's deadline and cancellation, and its reads use the same scope and read dependencies as the tool's own `context.store` reads. Calls still running when the tool returns are cancelled. A failed service call rejects with the service's error; a tool that lets it through answers the model by the error mapping of [Imported service tools](./tools.md#imported-service-tools), the service call trace still names the provider, and the failure does not count as the caller's fault.
- An agent can import **model-facing** services in `agent.tools.services`. Each import becomes a read-only tool; see [Model-facing services](#model-facing-services) below. The framework does not hand every service to every agent.

Services called from a tool or an import get no `gateway` or `utils`: model work belongs to the caller.

### How events trigger downstream work

An event that a runtime emits moves through the subscribers in the same turn's event chain, one layer at a time.

- In each layer, the matched runtimes run in the order set by their declared `needs` / `after` / `inputs` relationships. A result from one layer is visible at once to the next layer.
- A provider that does not match is not triggered as an extra.
- Background followers, and tasks that an event from the interface triggers, are each separate durable tasks. The ordering within one turn does not cover them. There is no guarantee of order between them, and the success of one is not a condition for another.

When `needs` points to a contract that has only one provider, a result that the previous stage or previous event layer already satisfied still counts. Even if another provider in the current batch forms a circular dependency, a consumer whose need is already met can still run. The ordering rules for `after`, for needs that require all providers, and for input bindings do not change.

### Writes triggered by the interface: how the three actions differ

| Action               | What it does                                            | Writes                                                                                                                    |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `invokePluginAction` | Calls the plugin's RPC action                           | Takes effect right away. If the handler fails later, the writes made before that point are not rolled back automatically. |
| `invokeRuntime`      | Triggers a function runtime with `trigger.type: manual` | The `ctx.pluginData` writes and the domain effects go into the same proposal commit, so they succeed or fail together.    |
| `invokeCommand`      | Runs a player command that the manifest declares        | Goes through the command's validation and audit. Do not use `invokePluginAction` to bypass it.                            |

When several records must succeed or fail together, use `invokeRuntime`. This function handler does not need a model. A manual trigger does not run a narrative runtime by itself. Any event downstream that the runtime declares still runs under the scheduling rules.

An RPC action handler receives `ctx.signal`, which aborts at its time limit. The RPC channel below defines when store calls close and already-started writes settle.

See [RPC channel](./api.md#post-apisessionsidplugin-rpc) and [handler write contract](./plugins.md#inputs-and-outputs).

### Tools do not cross plugins

A plugin tool is registered in `entry` with `covel.registerTool()`, and its name must be unique within the plugin. Different plugins can use the same name without overwriting each other. A tool call only finds the calling plugin's own implementation, the framework's built-in tools and the services this runtime imports. For a capability that other plugins should use, make it a service, as described below: another plugin's tools call it through `context.services`, and to let another agent's model call it directly, make it a model-facing service that the agent imports in `agent.tools.services`.

### Packages without a runtime

Only a package with `entry`, hooks, or UI can have no runtime.

- Its hooks still run for the set of plugins that are enabled in the session.
- `ctx.getOwnSettings()` reads the defaults of the package-level `userSettings`, plus the overrides for this world and player. Having no runtime does not drop those defaults, and it does not create a runtime that gets scheduled.

Developers who embed the kernel in their own host also need to know this. Execution and commit each use a clear session hook scope. A host that calls `executeTurn` directly and wants to include a package with no runtime passes its `activePluginIds` and the resolved `settings` in `TurnExecutorDeps.hookScope`. The execution entry point records and freezes this scope, then passes it automatically to `commitExecution` along with `execution`. The Covel server builds this scope from the active set saved with the session. The hooks of a community plugin still check the current server-code authorization on each call.

### Hooks

For when each hook event fires, its payload, what it may return, and the context the handler receives, see [Hooks](./hooks.md). Some points that relate to communication:

- `contributes.hooks` declares the allowed hooks by `event` and `enforce`. If `enforce` is left out, it counts as `normal`.
- One declaration can call `covel.on()` several times to register several separate handlers.
- Registering an event or group that was not declared, or declaring one that is never implemented, makes the whole entry fail to publish.
- The handlers for one event run group by group: `pre`, then `normal`, then `post`. Inside a group, the framework's hooks run first, then the plugin's hooks run in registration order. The order between different plugins depends on load order. It is not a convention that a plugin can declare.
- When two plugins rewrite the same payload, the `replace` that runs later overwrites the same field from the earlier one. Plugins that need a fixed order should declare different `enforce` values.
- `TurnStop` fires after all runtimes of an execution finish and before the commit. At that point the writes are not yet saved, and they can still be rejected at commit. To do something after the data is saved, use `PostStateCommit`.

## Plugin author types

An external plugin imports the `PluginAPI` or `PluginEntryFactory` types from the public package `@covel/plugin-handlers-utils`. It does not need to install the private runtime and shared packages.

| Entry                                           | What it provides                                         |
| ----------------------------------------------- | -------------------------------------------------------- |
| `@covel/plugin-handlers-utils`                  | `PluginAPI`, `PluginEntryFactory`                        |
| `@covel/plugin-handlers-utils/extension-points` | The input, output, and context types of extension points |
| `@covel/plugin-handlers-utils/plugin-api`       | The full entry types                                     |

```js
/** @type {import("@covel/plugin-handlers-utils").PluginEntryFactory} */
export default function (covel) {
  covel.provideExtension("prompt.segment@1", "direction", {
    handler: (_input, ctx) => [
      {
        id: "direction",
        content: `Locale: ${ctx.locale}`,
        position: "system",
        audience: "self",
        volatility: "turn",
      },
    ],
  });
}
```

With TypeScript, or with `checkJs` turned on for JavaScript, known extension points constrain the input and output of a handler. Type checks do not replace other checks. The manifest declaration and the runtime schema validation are still required, and authorization and output validation still run as usual.

The SDK also exports `estimateTokens`, `FRAMEWORK_TOOL_NAMES`, helpers for multilingual text and forms, and more. For the full list, see [helper functions in the public SDK](./extension-points.md#helper-functions-in-the-public-sdk).

> [!IMPORTANT]
> A relative import in a plugin's JavaScript module must point to a file that really exists in the package. When you import a TypeScript file that is not compiled, write the real `.ts` extension.
>
> When you develop in the repository, `pnpm dev` starts with the tsx loader, and that loader handles these imports. Node's built-in type stripping does not map a `.js` import to a `.ts` file. So loading the whole source dependency graph directly with `import(...)` in `node` does not work.

## Entry resource lifecycle

The `entry` factory can open connections, start timers, and build caches. This section explains when those resources should be closed and how to close them.

- `covel.signal` stands for this one plugin activation. It is cancelled when initialization fails or the host shuts down.
- `covel.onDispose(callback)` registers a cleanup function while the factory runs. It can be synchronous or asynchronous. Use it to close subscriptions, connections, timers, and shared caches.
- Register the cleanup for a resource **right away** after you get it, before you do any next step of initialization that might fail.

```js
export default function (covel) {
  const cache = new Map();
  const timer = setInterval(() => cache.clear(), 60_000);
  covel.onDispose(() => {
    clearInterval(timer);
    cache.clear();
  });
  // Pass covel.signal to asynchronous initialization and shared resource work.
  // Register services, tools or RPC handlers here.
}
```

### Shutdown order

1. Cancel the signal, which stops new registrations.
2. Withdraw the capabilities that were already published.
3. Wait for the cleanup functions in the reverse of the order they were registered.

If one cleanup function fails, the others still run, and the errors are reported together. Closing a second time does not run the callbacks again. When initialization fails, the resources already obtained are also cleaned up, and a retry uses a new signal. The test runner also closes the entry resources after a run finishes or fails.

### Time limits

| Item                                                   | Default limit |
| ------------------------------------------------------ | ------------- |
| Server entry initialization                            | 15 seconds    |
| Rollback cleanup after failed initialization           | 15 seconds    |
| Back-off for passive service discovery after a failure | 30 seconds    |

A cleanup timeout does not stop the failure result from being returned, a later retry, or other sessions from getting a snapshot. When the host shuts down, it still reports failed cleanups that have not finished. Explicit activation and reload are not limited by the back-off, and they can retry right away.

### Concurrency

The preparation work for the first activation and for a reload is queued for the same plugin. The factory run, loading the runtime modules, and cleanup after a failure do not hold up the global publish queue. Other plugins, and sessions that do not depend on this plugin, can keep running.

If a new version is published while an execution is getting its runtimes, the host takes the snapshot again. This makes sure that one execution uses tools, services, and runtimes from the same version.

### Entry does not belong to one session

> [!WARNING]
> The host activates each entry only once per plugin, and all sessions share it. Do not put session data in top-level module variables or in closures.

- Disabling a plugin in one session does not destroy an entry that other sessions share.
- Store session data in the call context and the plugin data store.
- Use `ctx.signal` to cancel a single task. To know when a session ends, use the `SessionEnd` hook.
- This mechanism depends on the plugin to cooperate with cancellation and cleanup. It cannot forcibly stop JavaScript that ignores the signal, and it does not provide a separate background scheduler.

### How the host reports status

`hostState` in the host directory describes only the actual publish state of an entry: `discovered` / `installed` / `loaded` / `error`. It does not include "approved".

Authorization and enabling are per session. The session API reports them separately: the live `serverCodeApproved`, and after dependency resolution, `sessionState` / `autoAdded` / `rejection`. You cannot infer from the global `loaded` whether another session has granted authorization.

If the first activation fails, the state shows `error`. If a reload fails but the old version is still kept, the state still shows `loaded`, and the error message is shown separately.

## Single-plugin hot reload during development

You can change the files of a community plugin without restarting the service. This works only under `NODE_ENV=development`. Built-in plugins and production do not allow it.

### How to trigger it

- Manually: `POST /api/plugins/:id/reload`, with an optional request body `{ "sessionId": "..." }`.
- Automatically: the development host watches the community plugin directory and merges file changes that happen within 150 milliseconds into one reload. It goes through the same reload path. Under `pnpm dev` there is one exception: its watcher (`tsx watch`) also follows every code file the server has already loaded, so a change to such a file (a `handler.js` that has run, the entry, and the modules they import) restarts the whole backend and does not go through this reload; a community plugin must then be authorized again. Manifests, UI files and translations are not affected and still reload this way.

Both ways have the same conditions:

- The operation must pass the local or administrator authentication of the install API.
- A session must provide a currently valid server-code authorization. If a session is named in the request, that session is used. If none is named, a session that once approved this plugin is used.
- Without a valid authorization, the plugin code is not run.

### What a reload does

1. Parse the new declarations, run the new entry factory, and check that the registrations match the declarations.
2. Preload the handlers and guards (only those that have both server-code and runtime authorization).
3. Publish the tools, hooks, RPC, services, form validators, wires, and runtime metadata all at once.

If preparation fails, the old version is kept.

Executions that are already running keep using the old version, and later executions use the new one. The old version no longer accepts new lookups. Its `onDispose()` is called only after every execution using it has finished, and after any provider promise still pending past the timeout has been released. A snapshot does not store authorization. Calls and commits still check whether authorization has been revoked.

### Sessions after a reload

After a new version is published, each session's next execution first resolves its dependencies again, and only then takes the new snapshot. The resolution uses the player's original request, the plugins that were explicitly excluded, and the current authorization.

- If a new required contract is added with no provider, or a conflict appears, the plugin cannot keep running on the old activation result. After you fix the declaration, the player's original choices are still kept.
- Executions that have already started keep their original activation and service references. But an explicit disable, a revoked authorization, or a replaced session still makes them invalid.

### Event schemas

Event schemas are read and compiled at startup and while a new version is being prepared. Both the compile result and a compile failure are cached per version, and only then is the new declaration published. A fix to a file at the same path takes effect only at the next reload. An old version that is already in use keeps its original validator even if it has not yet handled this event, so later edits on disk do not affect it.

### Community plugins that fail to parse at startup

A community plugin whose static parse fails at startup still keeps its discovery location, and it still accepts file watching.

- A reload only reuses this package's ID, root directory, and discovery source. It checks the layout again from the current files, and does not inherit the old `layoutError`. After you add the root `PLUGIN.md`, or fix the name of a child manifest file, it can recover.
- If a new scan still has errors, no new declaration is published, and the failed discovery location is not cleared.
- After the file is fixed, if this plugin has never published any capability, the host can validate it again and publish its **static declarations** without server-code authorization. This does not import the entry, handlers, or guards. The first activation still goes through the normal approval.
- A plugin that already has an active version cannot use this recovery path.
- If a watched directory disappears, the host only logs one warning and does not stop startup.

### Changes that a reload cannot apply

> [!NOTE]
> Every reload imports the entry, handlers, and guards again, together with the ES modules inside the plugin directory that they import with relative paths. So when you change only a dependency module such as `lib/helper.js` and save, the new code takes effect too.

- Within one reload, the entry, handlers, and guards share one new copy of each dependency module; the previous version keeps using its own copy. Top-level state in a dependency module is therefore not carried over to the new version. Store data that must survive in plugin data.
- These are not loaded again: files outside the plugin directory, packages in `node_modules` (including `@covel/plugin-handlers-utils`), CommonJS files (`.cjs`), and native modules (`.node`). If you change them, the host code, or top-level resources that cannot be cleaned up safely, restart the service.
- Node does not release a module that it has loaded. Every reload leaves one more copy of the plugin's modules in memory, and only a restart of the service reclaims them; after many reloads over a long time, restart once.

## Registering and calling public functions

A plugin can expose a function to other plugins. This is called a **service**.

### Registration

A service is registered while the `entry` factory runs. It is published together with the tools, hooks, and RPC: it takes effect only if everything succeeds, and if anything fails, all of it is withdrawn. The registration is removed when the host shuts down.

- A service name must be unique within its plugin.
- `contract` is the public contract ID that the plugin author defines, shaped `<name>@<major>`: it starts with a lowercase letter and has only lowercase letters, digits, `.` and `-`, such as `my-plugin.rank@1`.
- Make an incompatible change with a new contract. Do not write a migration for development data.
- Declare every registered service in `contributes.services` of `PLUGIN.md` by its contract ID; write a model-facing one as `{ contract, modelFacing: true }`. When the declaration and the registration disagree, the whole registration batch fails.

```js
export default function (covel) {
  const { z } = covel.toolkit;
  covel.registerService({
    name: "rank",
    contract: "my-plugin.rank@1",
    input: z.object({ candidates: z.array(z.string()).min(1) }),
    output: z.object({ selected: z.string() }),
    async handler(input, ctx) {
      ctx.signal.throwIfAborted();
      return { selected: input.candidates[0] };
    },
  });
}
```

### Discovery and calls

Another plugin first uses `ctx.services.discover("my-plugin.rank@1")` to find the providers. This returns `{ pluginId, name, contract, description? }[]`. Then it chooses one provider explicitly and calls it.

When there are several providers, the calling plugin's settings or its business rules decide which one to use. The framework does not guess by plugin name, and it does not pick the first one automatically.

```js
const value = await ctx.services.call({
  pluginId: configuredProviderId,
  name: "rank",
  contract: "my-plugin.rank@1",
  input: { candidates: ["Visit the library", "Explore the classroom"] },
});
```

You can give one call a shorter time limit than the runtime's, or cancel it on its own:

```js
const value = await ctx.services.call(
  {
    pluginId: configuredProviderId,
    name: "rank",
    contract: "my-plugin.rank@1",
    input: { candidates: ["Visit the library", "Explore the classroom"] },
  },
  { timeoutMs: 1500, signal: ctx.signal },
);
```

### Timeouts and cancellation

- `timeoutMs` is a positive, finite number of milliseconds, with a maximum of `2147483647`. It includes the time spent waiting to be admitted in the queue and the time the call actually runs.
- A timeout throws an exception with `name: "TimeoutError"`. When the call is cancelled on its own, the cancel reason is kept.
- When the parent runtime is cancelled, the service call is cancelled too. The reverse is not true: if a call times out or is cancelled, the parent runtime is not cancelled. The caller can catch the error and use a fallback provider instead.
- A service that calls other services, gateways, or HTTP requests passes on the signal of this call.
- When a call ends, its context is closed. Do not store the context and keep using it after the return to start more work.
- Async code that does not cooperate with cancellation may keep running, but the caller stops waiting in time. A late result is not returned as a success.

### Checks before a call

Before each call, the framework checks again: that the caller and the provider are still enabled, and that the community plugin's server code is still approved to run.

- The discovery interface does not activate community code that is not approved to run.
- A service being registered in the process does not mean the current session may call it.

### What a service can and cannot access

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `callerPluginId` | The immediate caller's plugin; in a nested call, the previous provider. |
| `signal` | Cancellation and deadline signal; reads check it before and after waiting for storage. |
| `gateway` | Optional model access without the caller's key material. |
| `utils` | Optional HTTP helpers that inherit this call's signal. |
| `services` | Discover and call other public services. |
| `sessionId` | The current session. |
| `locale` | The session content language; optional when the host supplies none. |
| `pluginData` | The provider's own read-only data; `get(namespace, key)` returns a value or `null`, and `list(namespace)` returns `{ key, value }[]` in store order. `_hidden.*` namespaces return `null` / an empty list. |
| `world` | A separate read-only copy of the calling runtime's world view, cloned on first access. |
| `getOwnSettings()` | The provider's resolved, frozen settings for this turn; an empty object when none exist. |

- Input and output are checked against their schemas and copied. You cannot change the other side's state through an object reference.
- Each data read returns a separate copy. The context has no caller store, tools, settings, or write buffer.
- Services have no write methods and cannot produce proposals. The calling runtime decides how to persist the result; write services will come later.
- A chain of service calls cannot loop, and it can go at most eight levels deep. It inherits the runtime's deadline and its capability revocation.
- A service must pass `signal` to asynchronous work. It must not leave tasks running in the background after the call.
- Ordinary JavaScript on the server still follows the authorization model for community code. This is not a process-level sandbox.

When called through a runtime's client, `pluginData` overlays committed data with the provider plugin's completed, commit-eligible upstream writes in this execution, in commit order. Retry or background seed results are not applied again. Parallel runtimes in the same level cannot see each other's writes. The original runtime's own write buffer is applied last only when the provider belongs to that runtime's plugin. Lists remove deleted keys and append new keys in write order. Clients outside an execution read committed data only and record no read dependencies.

A read that sees an uncommitted upstream write records a read dependency on the calling runtime's result. Nested services read each provider's own data and keep recording on the original runtime. If a producer is dropped at commit, an auxiliary caller is dropped with it; a story caller still commits and the trace records the dependency (see [Transactions](./transactions.md)). Calling a read service creates no new scheduling dependency; a story runtime can call it as needed and handle missing or failed services.

Calls from tools and imports read the same data: the tools of a top-level agent overlay upstream writes and record read dependencies like a function runtime. When a resumed runtime or a sub-agent calls a service from a tool, it reads committed data only and records no read dependencies, the same as its own tool reads.

### Model-facing services

When a provider marks a service as model-facing, an agent can import it in `agent.tools.services` and its model calls it directly. The mark goes in two places, and they must agree:

```yaml
# PLUGIN.md
contributes:
  services:
    - { contract: inventory.items@1, modelFacing: true }
```

```js
covel.registerService({
  name: "items",
  contract: "inventory.items@1",
  modelFacing: true,
  description: "List the items in one of the player's bags.",
  input: z.object({ bag: z.string().describe("Bag name") }),
  output: z.object({ items: z.array(z.object({ name: z.string() })) }),
  handler: async ({ bag }, ctx) => ({
    items: (await ctx.pluginData.get("bags", bag)) ?? [],
  }),
});
```

A service can be imported when:

- it is declared as `{ contract, modelFacing: true }` and registered with `modelFacing: true`;
- it has a non-empty `description`, which is the tool description the model reads;
- its input exports JSON Schema: a Zod schema is exported automatically (without `$schema` and without patterns a provider cannot read); for an input that is not Zod, or a Zod input that has no JSON Schema form (such as one using `z.custom`), give an explicit `inputSchema`, and the Zod input is then not exported. The root must be `type: "object"`.

These are checked at registration. When one fails, the whole registration batch fails, not a later turn. `modelFacing` stays out of the capability snapshot: the mark gives the provider's code no new power, so a package from a trusted source is not confirmed again.

The importing agent writes:

```yaml
agent:
  tools:
    services:
      - inventory.items@1 # tool name inventory-items
      - { contract: world.map@2, as: look-at-map }
```

The tool name is the contract without its version, dots as dashes; `as` names it otherwise. For the name rules, schema, annotations, time limit and errors, see [Imported service tools](./tools.md#imported-service-tools). A function runtime cannot write `tools.services`; it uses `ctx.services` directly.

At each runtime start the framework finds a provider for each import. The candidates are plugins that declare the contract as model-facing and are enabled and approved to run, plus plugins paused after repeated errors:

| Case                                        | Result                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Exactly one active provider                 | The tool is generated and bound to that provider                                                      |
| No provider                                 | The tool is absent; a call to it answers `unavailable`                                                |
| Providers, but none model-facing            | The same, and the text says the provider does not offer it to models                                  |
| More than one model-facing provider         | The same, and the text says more than one plugin provides it; no guess by name, no first pick         |
| The only provider is paused                 | The same, and the text says the provider is paused; the tool returns once a later execution clears it |
| One active provider and one paused provider | Counted as more than one provider: the active one is never silently substituted                       |

A missing import removes only its tool: the runtime starts and the story commits as usual. Imports create no scheduling edge and do not make the package require its provider; an imported tool cannot complete a runtime (`finishWith` and `completion.afterTools` cannot name it). The host tells the framework which plugins are paused through its admission interface; for an embedder without it, a paused provider is simply unknown.

Service calls made from a tool carry its `toolCallId` in `plugin.service.completed`, and nested calls inherit it; see [Protocol](./protocol.md).

## Models and new protocols

When a plugin needs to call a model, or connect a new provider, choose the approach that fits the case below.

### Use the model features that already exist

- Text, images, speech, and music: use `ctx.gateway`, `ctx.images`, `ctx.speech`, and `ctx.music`. Their types (`PluginServiceGateway`, `PluginImages`, `PluginSpeech`, `PluginMusic`, `PluginMedia`) are exported by `@covel/plugin-handlers-utils`, and the host implements exactly these types.
- Evaluation: `ctx.gateway.evaluate({ presetId, state, questions, signal })`. It supports three kinds of questions: Boolean, Choice, and Score.

### Budget when you build a long prompt yourself

- `ctx.gateway.resolveSlot({ presetId })?.limits` gives the `{ contextWindow, maxOutputTokens }` that the gateway actually uses for this slot. If the model does not declare a context window, this field is left out. The framework does not give you its own fallback value as if it were the real limit.
- `generateText` and `generateObject` accept `maxOutputTokens` as the limit for a single call. It can only be lower than the output budget the player set for this slot. It cannot be raised.

### Ask for a JSON reply

Pass `responseFormat: { type: "json_schema", schema }` to `generateText`. Protocols that support JSON mode turn it on, and the schema is also added to the messages as an instruction.

The returned `text` is still text. The plugin parses it itself and checks that the content is correct. When a reply cannot be read, use `ctx.logger.warn` to keep an excerpt with a length limit. The trace does not save the body of the reply.

### Logs

| Method           | Where it is written                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warn` / `error` | The `_logs` ring of this session. Also one line in the server log: `[plugin-log] <runtimeId>: <message> <meta>` (`meta` is cut at 2000 characters). |
| `debug` / `info` | Only the `_logs` ring.                                                                                                                              |

This way, operators can see warnings and errors without digging through session data.

### A new provider or a new protocol

| Case                                                                                       | What to do                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new provider that uses an existing wire                                                  | Only configure the provider, the base URL, the model, and the model role. No plugin or framework change is needed.                                                                                                                                                                             |
| A new wire, or a new kind of response                                                      | Inside a service, use `ctx.gateway.resolveSlot` to get the model configuration for this request. Then use `ctx.utils.validateBaseUrl` / `fetchWithRetry` to implement the protocol, and define your own input and output schemas. Give the result to other plugins through a service contract. |
| Images, speech, transcription, or music, where you want to reuse the shared media pipeline | Use `covel.registerWires`. Saving media still goes through the existing media interface.                                                                                                                                                                                                       |
| A new text protocol (a request and response format beyond the four built in)               | Also register it with `covel.registerWires`. See [text protocol wire](#text-protocol-wire) below. Once registered, it works like a built-in protocol: any text role can select it, and so can the main narrative.                                                                              |

Keys stay on the server only. They are not written into results, logs, or the interface.

### Music generation

```text
ctx.music.generate({ prompt, lyrics?, instrumental?, durationSeconds?, format?, presetId?, metadata?, signal? })
  → { refs, warnings, cached }
```

- The rules for de-duplication and saving are the same as for `ctx.speech.generate`.
- `ctx.music.isAvailable(presetId?)` only checks whether a music role is configured. It does not send a request to the provider.
- The kernel does not include a music wire. A plugin that connects a music model registers it with `covel.registerWires({ music: [{ id, compose }] })`. `compose(config, params, context)` returns `{ audio: { mimeType, data }, usage, warnings }`. For a provider that needs polling, poll inside `compose` and return only when it is done.

> [!WARNING]
> Generating one song can take from tens of seconds to several minutes. Call it only from a detached or background runtime. Do not put it inside a turn.

### Permissions do not grow across plugins

A gateway used by a service inherits the request settings, tracing, cancellation, and revocation boundaries of the runtime that made the call. HTTP requests are sent by the provider's code, so they are checked against the provider's declaration: in a community provider's handler, `context.utils`, like its `covel.http`, reaches only the origins listed in the `permissions.http` of its own package, whoever the caller is. An extension handler works the same way. If the gateway already has a standard method for the job, use the gateway first.

### The scope of "no framework change needed"

This means a plugin can build a feature with its own contracts. If you want the framework's general model settings, scheduler, or media system to know directly about a brand-new kind of capability (beyond text, images, speech, transcription, music, and evaluation), you still have to change the host's public contracts. Registering a service does not add a new item to that list of capabilities by itself.

### Text protocol wire

```js
export default function register(covel) {
  covel.registerWires({
    text: [
      {
        id: "converse",
        label: "Acme Converse",
        async generateText(config, params, context) {
          const response = await covel.http.fetchWithRetry(
            `${config.baseUrl}/converse`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${config.apiKey}` },
              body: JSON.stringify(toAcmeRequest(params)),
              signal: config.signal,
            },
          );
          const body = await response.json();
          return {
            text: body.output,
            finishReason: body.stopReason,
            usage: { inputTokens: body.in, outputTokens: body.out },
          };
        },
        async *streamText(config, params, context) {
          // yield { type: "text-delta", textDelta } … then one final
          // { type: "done", finishReason, usage }
        },
      },
    ],
  });
}
```

Declaration and naming:

- As with image, speech, and other wires, the text wire's `id` must be written in the manifest's `contributes.wires` (in the example above, `wires: [converse]`). If something is registered but not declared, or declared but not registered, the plugin fails to load.
- The registered name is `<pluginId>/<wireId>` (in the example above, `acme/converse`). For a model's `protocol`, write this name. Both `llm.toml` and the settings page accept it.
- The protocol dropdown on the settings page lists the protocols that loaded plugins have registered, using `GET /api/ai/protocols`. It shows the name from `label`.

What you must implement:

- You must implement `generateText` and `streamText`. For the types, see `PluginTextWire` in `@covel/plugin-handlers-utils`.
- `params` includes `model`, `messages` (with tool calls and tool results), `tools`, `responseFormat`, and `providerRequestMetadata`.
- Message text and text blocks contain no internal prompt-cache markers. `instructionLocale` is the host-selected instruction language (`en` or `zh`). The fallback for structured output uses it too.
- The last event in a stream must be `done`.
- `finishReason` can return the provider's own word directly. The gateway converts it to a common value such as `stop`, `length`, or `tool_calls` (see the notes on finish reasons in [slots.md](./slots.md#connection-tests-and-failure-reasons)).
- You do not need to implement structured output on its own. The gateway puts the JSON Schema into `responseFormat`, adds it to the messages as an instruction, calls `generateText`, and then parses and validates the result.
- Embeddings do not go through a text wire.
- The optional `listModels(config, signal)` returns the model IDs that the endpoint provides. The "Read the model list from the service" option on the settings page uses it.

Requests and keys:

- The wire sends its own HTTP requests. So these requests do not appear in the provider request trace, and the framework's transport retries and request budget do not apply to them.
- `config.signal` fires when the call is cancelled or times out. Pass it to the request.
- `config` holds the address and key that this role resolves to. They may only be used to send requests to that address. They must not be written into results, logs, or the interface.
- If the plugin that the model's `protocol` points to is not loaded, or is not enabled in the current session, the call fails with a configuration error. The error says which plugin to enable. The call does not switch to another protocol.

Which requests can select this protocol:

| Request                                                                                                 | Condition                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A request inside a session                                                                              | The plugin is enabled in this session. (For a community plugin, enabling it already includes the player's authorization.)                         |
| A request that is not part of any session (connection test, reading the model list, generating a world) | Can select the protocol of a built-in plugin.                                                                                                     |
| The same as above, in the `self` deployment                                                             | There is only one player, and every loaded community plugin was authorized by that player. So a community plugin's protocol can also be selected. |
| The same as above, in the hosted deployment                                                             | A community plugin's protocol must be used in a session that has enabled it.                                                                      |

A request-level preset, the `llm.toml` slots, and a runtime's own slot preference are all checked against this table. The protocol dropdown on the settings page still lists the protocols of all loaded plugins. Image, speech, transcription and music wires that a plugin registers are chosen by the same table; when none can be chosen, generation fails with a configuration error that names the plugin to enable.

> [!CAUTION]
> The trust boundary is the same as for media wires. A community plugin's server code runs only after the player authorizes it. `covel.http` in a wire reaches only the origins declared in the package's `permissions.http` and the endpoint of the slot it is serving. The difference is that a text wire handles **all the prompts and answers** of the role that selects it.

## Custom components and mounting

A plugin declares a JSON shell in `ui.right`. Inside it, you use either `view` (an interface described in JSON) or `webview` (an HTML file). You choose one of the two. A business interface does not have to use the components that the framework provides.

```json
{
  "id": "my-widget",
  "label": "My widget",
  "surfaces": ["panel", "stage"],
  "dataSource": { "namespace": "results" },
  "webview": { "entry": "./widget.html", "height": 280 }
}
```

### Where the panel appears

- `surfaces` defaults to `panel`, which is the right-side panel.
- If you declare `stage`, the panel is also mounted in the decision area of the stage. This location also supports a JSON `view`.
- Each plugin panel in the right-side panel has an "Expand panel" button. It moves the same panel into a large dialog. Only one instance can exist at a time. There, a `webview` takes about 72vh of height, and `height` does not limit it. This is host behavior, so the spec does not need to declare it.

The host only provides the existing mount points. It does not care about the business of a panel: it does not know whether a panel is a recommendation, a dice roller, or a map. To add a new product-level global location, the host still has to provide it.

### Requirements for the HTML file

- `webview.entry` is relative to this JSON file. It must be a `.html` file inside the plugin's root directory. Its real path (including where a symbolic link points) cannot leave the plugin directory.
- A single file can be at most 512 KiB.
- You can use native DOM, Canvas, and SVG, or build React, Vue, or similar into a single HTML file that contains its scripts and styles.
- You do not need to change the Web source code or rebuild the framework. During development, changes to a community plugin's files reload the registry automatically. In other environments, restart the server.

### Sandbox

The HTML runs inside two layers of iframes with `sandbox="allow-scripts"`. Each layer is a separate opaque origin, and neither can reach the host's DOM, cookies, localStorage, or provider keys.

| Layer | What it is                                                                                                                                              | What it does                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outer | The static document `/plugin-frame.html` that the Web build includes. It loads by URL and has its own CSP (it does not inherit the main page's policy). | Only two things: it puts the plugin HTML into the inner layer, and it passes the bridge port once. Its `frame-src 'none'` stops the inner layer from navigating to a network address. |
| Inner | The plugin's HTML, loaded through `srcdoc`. It inherits the outer layer's policy.                                                                       | It can use inline scripts (including inline event attributes such as `onclick`), inline styles, the DOM, Canvas, SVG, and the action bridge.                                          |

Plugin HTML does not need any change for this structure. The limits to know about:

- A plugin cannot change the outer layer's policy, and it cannot make the outer layer or the top-level page navigate.
- If the inner document reloads, it does not get the bridge port again. When the HTML file changes, the host creates the whole container again.
- The CSP blocks fetch, form submission, and loading external scripts and styles. Bundle dependencies and resources into inline content or data resources.
- Do not call the Covel HTTP API directly from the HTML.
- The state that comes through the bridge is data the plugin can read, so it should not contain keys.
- This interface boundary does not change the trust model for server-side plugin code. It also does not provide quotas for CPU, memory, or rendering resources.

### `window.covel`

The host injects `window.covel` into the page:

```js
const unsubscribe = window.covel.subscribe(
  ({ data, locale, locked, context, uiState, theme }) => {
    // Render with textContent or your UI framework's escaping.
  },
);
const snapshot = window.covel.getState();
const response = await window.covel.invoke("invokePluginAction", {
  action: "refresh",
  payload: { limit: 10 },
});
```

Fields in the state:

| Field     | Content                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`    | The data of the namespaces this plugin declares. Updates and deletions arrive from the host's data source.                                                                                                                                                                                              |
| `locale`  | The current language.                                                                                                                                                                                                                                                                                   |
| `locked`  | The interaction lock. The host also rejects actions that arrive while it is locked.                                                                                                                                                                                                                     |
| `context` | On the stage, it is `{ surface: "stage", turnId, turnIds, choices }`. `turnIds` includes the committed retries that belong to the current narrative. `choices` is the current `{ id, text }[]`. A plugin can use them to check the turn and the current choices, and hide results that are out of date. |
| `uiState` | Temporary state for this panel. See below.                                                                                                                                                                                                                                                              |
| `theme`   | The current style scheme. See below.                                                                                                                                                                                                                                                                    |

### Follow the theme

`theme` is `{ id, scheme: "light" | "dark", tokens }`. `tokens` is a set of strings that are already resolved:

`background`, `surface`, `foreground`, `mutedForeground`, `border`, `accent`, `accentForeground`, `success`, `warning`, `danger`, `radiusControl`, `radiusCard`, `fontSans`, `fontSerif`, `fontDisplay`.

The host also writes these as CSS variables on the document root element. The names turn camel case into hyphens: `--covel-background`, `--covel-font-sans`, and so on. It also sets `color-scheme` and `data-covel-scheme`. So a stylesheet can use `color: var(--covel-foreground)` directly, and it updates automatically when the player switches the scheme or the light and dark mode.

> [!NOTE]
> The sandbox cannot load the host's font files. The font variables only work when the matching font is already installed on the system. Remember to write fallback fonts.

### Actions the panel can send

The bridge accepts only the actions that the host explicitly provides:

| Action                                                 | Where it is available | Notes                                                                    |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------ |
| `invokeRuntime`, `invokePluginAction`, `invokeCommand` | Everywhere            | Execution actions. They are bound to the current plugin automatically.   |
| `emitEvent({ topic, data })`                           | Everywhere            | Emits an event that this plugin declares.                                |
| `draftMessage({ text, selectionGroup? })`              | Right-side panel      | Puts a line into the pending area, to be sent after the player confirms. |
| `sendMessage({ text })`                                | Stage                 | Fills the stage input for the player to confirm and send.                |
| `setUiState({ value })`                                | Everywhere            | Saves the temporary state of the panel. See below.                       |

You cannot change the pluginId in a parameter to call another plugin. When you need to work with another plugin, use `ctx.services` or an event from your own runtime. Do not read the other plugin's private data in the browser.

Execution actions return the existing RPC response. A background `accepted` only means the task was received. It does not mean the task is done. Exceptions from bridge communication and calls come back as errors that do not include internal server details. Each mounted instance has its own connection, which closes when the panel unmounts. A plugin cannot get any arbitrary function from the host.

### Temporary panel state `uiState`

`uiState` is one temporary JSON state for the current panel. It starts as `null`. It is used to keep things like a draft that does not need to go to the server.

```js
await window.covel.invoke("setUiState", { value: { draft: "..." } });
```

- Each call replaces the whole state. Pass `value: null` to clear it. On success it returns `{ status: "ok" }`.
- After it is encoded as JSON, it can be at most 32 KiB (UTF-8). An invalid value or one over the limit is rejected, and the old value is kept.
- It has nothing to do with `data`. It does not write to the server and does not call a runtime.
- This action is also subject to the interaction lock.

How long it is kept:

- The sidebar caches state separately for each session, plugin, and panel, so it can be restored after you switch tabs.
- A panel that needs to restore a draft should declare a stable `id`. A panel without an `id` gets its identity from its order in the package.
- Leaving the session, destroying the sidebar host, or refreshing the page loses the state.
- Other locations that do not provide caching keep the state only until the panel unmounts.

> [!TIP]
> Restore the draft when the host first sends the state. Do not let later state updates overwrite the input box, or they will wipe out what the player is typing.

## Installable combined examples

- [Clickable Map](../../../tests/third-party/clickable-map/README.md) (in this repository): a minimal example of a custom-drawn panel. The `webview` draws the map with the host's scheme variables. Clicks go through `emitEvent` to an event runtime, which validates them and writes them. `draftMessage` passes the move to the narrative. `session.summary@1` reports the current position. `pnpm e2e:extensions` runs it in a real browser.
- [Official record workbench demo and two processing services](https://github.com/covel-ai/covel-plugins/tree/main/examples/notes-workbench) (in the plugin repository, not shipped with Covel): it shows a package-level HTML UI, the `/notes` command, a manual function runtime, service discovery, and an entry-only provider that can be replaced. The workbench only writes its own records, and the services only compute. Saving as-is, formatting, and project lists do not use a model. A new provider joins through the `examples.note-format@1` contract. Neither the framework nor the workbench branches on a provider ID.

## Check registrations and calls during development

In a session, type `/plugins` to open the plugin view on the debugger page. Type `/plugins my-plugin` to see only that package, along with the service records where it acts as the caller or the provider.

This command comes from the framework's command catalog. You can search it and use auto-complete, and it goes through the existing command RPC validation and tracing. It does not use up a player turn, and it does not call a model. `/debug` and `/trace` still open the original debugging entries.

### What the plugin view shows

- The install source, and the enabled and authorization state in the current session.
- The runtime IDs.
- The tools, hooks, RPC actions, and services that are actually registered, and the slash commands that are declared.

When you read this view, keep in mind:

- `registered` only means the command's action has been registered. When the command runs, the command arguments, the session, and the permissions of the matching action are still checked.
- A package that is not enabled or not authorized does not show its registered capabilities as currently available.
- This query only reads the host's registry and the session's dependency resolution result. It does not trigger the entry, service discovery, or any plugin code.
- Error messages use fixed explanatory text. When the host recognizes a registration error, it shows a structured `registrationError` (`code` / `registration`). To find the actual exception, look in the server log.

### Recent service calls

| Item                    | Details                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where it is kept        | Only in the memory of the current server process. It is cleared on restart. If a request lands on another process, this history is not visible.   |
| How many                | Up to 500 records for the whole process. Each response returns the latest 100 records for the current session, and you can filter them by plugin. |
| What it records         | Who called whom, which runtime and turn it belonged to, the duration, success / failure / timeout / cancellation, and a fixed error category.     |
| What it does not record | Arguments, results, raw exceptions, or the session's private identifiers.                                                                         |

So this window cannot be used as a durable audit or a usage count. Other details:

- A call that did not get the caller's admission scope does not enter the session history.
- If a session is deleted and then rebuilt with the same ID, the old records cannot be read.
- A request that did not match any service is shown with the identifier `<unavailable>`.
- A diagnostic string that is too long is cut at 256 UTF-16 units and marked with `...[truncated]`.
- The page supports manual and automatic refresh. When the session and the filter stay the same, a refresh keeps the current list, and the scroll position is not cleared. When you switch the session or the filter, the old data is hidden right away. When a query fails, the data already shown is also cleared.

For the interface, see the [plugin diagnostics API](./api.md#get-apisessionsidplugin-diagnostics). For local combined debugging, first use [test-runtime's --with-plugin](../plugins/testing.md#coveltest-runtime), and then use a real server to check approval, slash commands, hooks, and the interface.

### Failures and traces of extension calls

The output of one extension point call goes through three steps: the extension point's output schema, the authoritative owner handling, and the final schema validation. The three steps count as one settlement of the same call.

- A final error such as a slot type mismatch is recorded as one `error / output-validation`. Then the extension point's `onError` decides whether to skip or to fail the turn. It does not first record a success and then add a failure.
- A result that arrives only after the timeout does not add a success record.

**Durable trace.** An extension call with a turn emitter, a compression call, and a function service call are all written to the durable trace with the same completion event, `plugin.service.completed`. A nested call inherits the emitter and carries a `parentCallId`.

- The event only contains identity, the extension point's point / id / slot, the duration, and a fixed result category.
- The event does not contain the call's input, output, raw error, credentials, or the session's private identifiers.
- It reuses the traceId, seq, and retry scope of the existing TurnEmitter, and it waits until the write attempt finishes. When storage fails, it is handled as "best effort" as usual for traces, and it does not change the plugin's result. The duration does not include the time spent writing the trace.
- An interface-side background projection without a turn emitter is kept only in the in-process diagnostics window.

**Where to find the reason when a provider is skipped.** When an extension point with `onError` set to skip passes over a provider that failed or timed out, the server log has one line:

```text
[plugin-extensions] skipped provider <pluginId>/<extensionId> of <point> for session <sessionId>: <reason>
```

The trace event does not contain the raw error. If your own fragment or slot does not appear, look for the reason in this line.

A host caller can pass `onProviderError` in the scope of `createExecution`. When a skip happens, it receives the provider identifier and the raw error. History compression uses it to write the reason into the turn trace. See [extension point reference](./extension-points.md#history-compression-historycompact2).

**Statistics in diagnostics.** Diagnostics count, for each point and provider, the total, success, error, timeout, and cancelled values. They are based on the latest 100 calls returned now (the process keeps at most 500 in total).

- A cache hit, and concurrent calls that were merged within the same execution, do not add events or statistics.
- A provider that is not activated or not approved is excluded during discovery, so it does not count as a failed call.
- A call that fails admission after it was sent keeps its failure event.
- These statistics only describe the current window. They change as old records are removed. They are not cumulative usage.
