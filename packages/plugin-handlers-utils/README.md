# @covel/plugin-handlers-utils

Public ESM helpers and entry types for Covel plugin authors. Requires Node.js 26+.

```js
import { optionalString, makeProposal } from "@covel/plugin-handlers-utils";
import { runImageGeneration } from "@covel/plugin-handlers-utils/image-generation";
```

The root exports input normalization, locale selection, cancellation, typed proposals, explicit tool results, short IDs, plugin-data overlays, and narrative review helpers. The `image-generation` subpath exports the shared image pipeline handler and its structural context types. The `extension-points` subpath (also re-exported from the root) carries the typed public contract for kernel extension points: `PluginExtensionApi`, `ExtensionPointIo`, `ExtensionPointHandler`, the handler `ExtensionHandlerContext`, and every point's input/output shapes (`prompt.segment@1`, `prompt.history-transform@1`, `ui.slot@1`, `session.world-context@1`, `history.compact@2`, `media.image-flow@1`).

The root and `plugin-api` subpath also export `PluginAPI` and `PluginEntryFactory` for a unified server `entry` module. These cover lifecycle cleanup, tools, hooks, RPC, form validators, services, HTTP helpers, media wires, and known extension points. Authoring against the full entry facade requires the public `zod` peer package (`^4.4.3`) for precise schema and tool argument inference. The emitted declarations require no database, kernel, or private workspace package.

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

`PluginFunctionContext`, `PluginFunctionHandler`, and `PluginAgentGuard` cover the common scoped author API. The SDK owns `FunctionStoreView`, `PluginDataWriter`, `PluginLogger`, `HandlerResult`, and their effect types; host implementations reuse them. A handler can declare explicit additional capabilities through `PluginFunctionHandler<Capabilities>` instead of importing discovery or provider internals. Writes through `pluginData` remain scoped and buffered by the host. The locale helper selects Simplified Chinese for `zh`, `zh-CN`, and `zh-Hans` (case/underscore insensitive), and English otherwise.

Build with `pnpm --filter @covel/plugin-handlers-utils build`. Create a local archive with `pnpm --filter @covel/plugin-handlers-utils pack --pack-destination <directory>`; `prepack` emits `dist/*.js` and `dist/*.d.ts`. `pnpm --filter @covel/plugin-handlers-utils test:package` imports and typechecks that archive in a temporary directory without workspace packages.

Covel's plugin installer does not install npm dependencies. Plugin authors should bundle the helpers into their standalone plugin artifact and include this package's MIT license. Installing this SDK in an authoring project does not change the standalone-plugin packaging requirement. No network publication is part of the build or validation workflow.

Workspace installation runs `prepare` to build `dist` before local development. Turbo build, test, and lint also build dependency artifacts. Published archives already include `dist`; consumers do not need the workspace or TypeScript compiler.
