# Plugin invocation context

Function handlers default-export `async function (ctx)`. Use public `@covel/shared/plugin-runtime` types while authoring; bundle runtime helpers into standalone plugin artifacts. A helper's types are structural and do not grant authority.

## Identity, inputs, and state

`ctx.pluginId`, `runtimeId`, `sessionId`, `turnId`, `locale`, and `signal` describe the current invocation. `ctx.userSettings` contains this plugin's settings. `ctx.messages` holds this plugin's `locales/` translations; read it with `translate(ctx, "English text", params)` and `labelText(ctx, "English text")`. `manualPayload` and `triggerEvent` supply invocation data. `ctx.inputs` contains typed same-execution bindings and `ctx.exports` contains declared committed bindings.

```yaml
schedule:
  stage: post-turn
  trigger: {type: auto}
io:
  inputs:
    narrative:
      from: {contract: narrative-engine@1, cardinality: one}
      select: /narrativeOutput
      required: true
```

Read `ctx.inputs.narrative.value`; an `all` binding contains `items[].value`. These slots also carry source provenance. Committed bindings use `scope: committed` and `recordAs`; the producer uses `io.output.recordAs`. Detached memory work receives a frozen `turn-digest@1` input. Do not reconstruct upstream output from another plugin's private data.

All plugin stores are scoped, including built-ins. Calls are bound to the current session and plugin: `getSession()`, `getWorld()`, `listTurnMessages(limit?)`, `listPlayerInputs()`, `getPluginData(namespace,key)`, and `listPluginData(namespace?)`. Do not pass `sessionId` or `pluginId`. The facade is read-only; raw DataStore is not a plugin API.

`ctx.world` exposes read-only characters, character schema, and the world record. Its execution view combines committed state, successfully completed upstream domain proposals, and valid buffered changes. It does not expose failed or merely running upstream mutations. Domain writes use proposals/effects and pass kernel validation; one player and the current character schema remain enforced.

## Results and effects

```js
export default async function (ctx) {
  ctx.signal.throwIfAborted();
  const text = ctx.inputs?.narrative?.value;
  if (!text) return {outcome: "skipped", skipReason: "No narrative"};
  return {
    outcome: "success",
    value: {saved: true},
    effects: {pluginData: [{namespace: "notes", key: "current", value: {text}}]},
  };
}
```

Supported outcomes are `success`, `skipped`, `failed`, and `blocked`. Domain effects commit only on success. `ctx.pluginData.set(namespace,key,value)` writes the execution buffer, not immediately committed state. `ctx.pluginData.get(namespace,key)` returns the stored value or `null`, and `list(namespace)` returns `{key, value, createdAt, updatedAt}` entries; an extension handler reads with the same two methods. `effects.pluginData` likewise targets only the owning plugin. Other effects include domain proposals, emitted events, UI interactions, notifications, and asset generation records, according to the host's public `HandlerResult` schema. Never write reserved `_jobs`/`_logs` namespaces as business data.

`ctx.progress.report` and `ctx.logger` report bounded execution diagnostics. Preserve the cancellation signal when invoking providers or services. Rethrow cancellation instead of converting it into a successful domain write. Return a failed/skipped result for unsupported configuration rather than inventing output.

## Public services and extensions

The entry declares each service in `contributes.services` and registers it with `covel.registerService({name,contract,description,input,output,handler})`. Use runtime `ctx.services` to discover and call approved active providers. Service boundaries validate and sanitize input/output, enforce cancellation/timeouts/cycle protection, and preserve caller authority. Provider gateways do not expose credentials through service slot results.

The entry declares extension `{point,id}` pairs in `contributes.extensions`, then calls `covel.provideExtension(point,id,{handler})`. Extension contexts expose an immutable execution snapshot of the provider's own plugin data and World Model, plus session/turn/locale and a bounded service context. Extension handlers do not receive a writable store. Point definitions own mode, schemas, timeout, merge rules, and diagnostics.

## Media and models

Use `ctx.gateway.generateText`, `generateObject`, or `evaluate` for model work. Use `ctx.images.generate` and `ctx.speech.generate`/`transcribe` for media: the host chooses a configured wire, enforces its network policy, persists bytes, and returns MediaRef values. Register custom protocol wires from the entry and list their local IDs in `contributes.wires`.

Use `ctx.media.put` or approved remote ingestion for already obtained media bytes. Persist references in own plugin data and return `effects.assetGenerations`. Do not store base64 blobs in plugin data. Custom network requests must use host helpers and declared runtime HTTP origins/methods; redirects need their own authorization. Keep credentials and provider responses out of public diagnostics and fixtures.
