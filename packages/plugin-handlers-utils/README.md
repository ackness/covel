# @covel/plugin-handlers-utils

Public ESM helpers and entry types for Covel plugin authors. Requires Node.js 26.12.1 or a later 26.x release.

```js
import { optionalString, makeProposal } from "@covel/plugin-handlers-utils";
import { runImageGeneration } from "@covel/plugin-handlers-utils/image-generation";
```

The root exports input normalization, locale selection, cancellation, typed proposals, explicit tool results, short IDs, plugin-data overlays (`overlayPluginDataValue`, `overlayPluginDataRows`: buffered writes projected over the stored value, with `plugin.data.update` operations applied by the same `applyDataOps` the commit uses), plugin-data operations (`applyDataOps`, `dataOpsSchema`), the dataset key rule (`datasetKey`: NFKC, trimmed, inner whitespace collapsed to one space, lower case; dataset tools key and find records by it), and narrative review helpers. The `dimensions` subpath serves dimension providers (schemas, queries, derived values and proposals for world dimensions). The `prompts` subpath loads plugin-owned prompt templates in Node. The `image-generation` subpath exports the shared image pipeline handler and its structural context types. The `extension-points` subpath (also re-exported from the root) carries the typed public contract for kernel extension points: `PluginExtensionApi`, `ExtensionPointIo`, `ExtensionPointHandler`, the handler `ExtensionHandlerContext`, and every point's input/output shapes (`prompt.segment@1`, `prompt.history-transform@1`, `ui.slot@1`, `session.world-context@1`, `history.compact@2`, `media.image-flow@1`).

The root and `plugin-api` subpath also export `PluginAPI` and `PluginEntryFactory` for a unified server `entry` module. These cover lifecycle cleanup, tools, hooks, RPC, form validators, services, HTTP helpers, media wires, and known extension points. Authoring against the full entry facade requires the public `zod` peer package (`^4.6.7`) for precise schema and tool argument inference, including recursive JSON types under TypeScript 7.1. The emitted declarations require no database, kernel, or private workspace package.

```js
/** @type {import("@covel/plugin-handlers-utils").PluginEntryFactory} */
export default function (covel) {
  covel.registerTool(
    covel.toolkit.tool({
      name: "echo",
      description: "Echo text",
      parameters: covel.toolkit.z.object({ text: covel.toolkit.z.string() }),
      execute: async ({ text }) => ({ text }),
    }),
  );
}
```

`makeProposal` checks the relationship between each proposal kind and its payload while preserving the supplied payload shape. The host still validates domain permissions and schemas before committing. `withPendingProposals(content, proposals)` always returns `{kind: "covel.tool-result", content, pendingProposals}`; `withEmittedEvents` composes the event channel. These envelopes have ordinary enumerable fields and preserve their effects through object spread, structured cloning and JSON transport. They never mutate the content. Use `getToolContent`, `getPendingProposals`, and `getEmittedEvents` when consuming a result; pure tools may return content directly.

The SDK result is the code-facing shape, separate from the executor's model-facing tool message. `withModelView(content, { summary, data })` selects the feedback the model receives; it composes with proposal and event helpers. Successful model feedback uses `{ summary?, data?, staged? }`, while failures use `{ error: { code, message, hint? } }`. Throw `ToolError` with a code from `TOOL_ERROR_CODES` for a failure the caller can act on. A `staged` notice means writes are buffered and may still be rejected at commit. Function runtimes receive the original content from `ctx.tools.call`; failures reject with `ToolError`. See the [tool result contract](../../docs/en/reference/tools.md#results-and-writes).

`PluginFunctionContext`, `PluginFunctionHandler`, and `PluginAgentGuard` type everything the host passes to a function handler or agent guard: the execution identity (`execution.sourceTurnId` on a retry), `recursionDepth` and `recursiveCall`, the read-only `PluginSessionView` from `store.getSession()`, the model `gateway`, `utils`, the media capabilities (`media`, `images`, `speech`, `music`, `assetProgress`), and `random`, which every context carries. The SDK owns `FunctionStoreView`, `PluginDataWriter`, `PluginLogger`, `HandlerResult`, the media types, and their effect types; host implementations reuse them, and a compile-time check in the workspace fails when the host's context and these types drift apart. `PluginTurnDigest` types the `turn-digest@1` kernel input. Writes through `pluginData` remain scoped and buffered by the host; `PluginDataWriter.update(namespace, key, ops)` submits operations that apply at commit to the latest stored value and throws when they fail against the current view. The locale helper selects Simplified Chinese for `zh`, `zh-CN`, and `zh-Hans` (case/underscore insensitive), and English otherwise.

Function runtimes can use `ctx.agents.run` to ask a declared sub-agent provider for output. Agent runtimes use the `delegate` tool. A sub-agent is read-only and has its own brief, transcript and budget. It differs from `ctx.recursiveCall`, whose same-package nested writes belong to the parent's commit unit. See [sub-agents](../../docs/en/reference/plugins.md#sub-agents) and [nested calls](../../docs/en/reference/plugins.md#nested-calls-ctxrecursivecall).

Build with `pnpm --filter @covel/plugin-handlers-utils build`. Create a local archive with `pnpm --filter @covel/plugin-handlers-utils pack --pack-destination <directory>`; `prepack` emits `dist/*.js` and `dist/*.d.ts`. `pnpm --filter @covel/plugin-handlers-utils test:package` imports and typechecks that archive in a temporary directory without workspace packages.

Covel's plugin installer does not install npm dependencies. The host provides this SDK and `zod` to every plugin: an import of `@covel/plugin-handlers-utils` (or a subpath) or `zod` from plugin code resolves to the host's copy, so a plugin does not bundle them. Bundle any other library the plugin uses. No network publication is part of the build or validation workflow.

Workspace installation runs `prepare` to build `dist` before local development. Turbo build, test, and lint also build dependency artifacts. Published archives already include `dist`; consumers do not need the workspace or TypeScript compiler.
