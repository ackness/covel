# @covel/plugin-handlers-utils

Public, dependency-free ESM helpers for Covel plugin handlers. Requires Node.js 26+.

```js
import { optionalString, makeProposal } from "@covel/plugin-handlers-utils";
import { runImageGeneration } from "@covel/plugin-handlers-utils/image-generation";
```

The root exports input normalization, locale selection, cancellation, proposal-envelope construction, and narrative review helpers. The image-generation subpath exports the shared image pipeline handler and its structural context types. No database, kernel, or private workspace package is required at runtime or by the emitted type declarations.

`makeProposal` preserves the supplied literal type and payload shape. It does not validate domain permissions or payload schemas; the host validates proposals before committing. Writes through a handler's `pluginData` context remain scoped and buffered by the host. The locale helper selects Simplified Chinese for `zh`, `zh-CN`, and `zh-Hans` (case/underscore insensitive), and English otherwise.

Build with `pnpm --filter @covel/plugin-handlers-utils build`. Create a local archive with `pnpm --filter @covel/plugin-handlers-utils pack --pack-destination <directory>`; `prepack` emits `dist/*.js` and `dist/*.d.ts`. `pnpm --filter @covel/plugin-handlers-utils test:package` imports and typechecks that archive in a temporary directory without workspace packages.

Covel's plugin installer does not install npm dependencies. Plugin authors should bundle the helpers into their standalone plugin artifact and include this package's MIT license. Installing this SDK in an authoring project does not change the standalone-plugin packaging requirement. No network publication is part of the build or validation workflow.

Workspace installation runs `prepare` to build `dist` before local development. Turbo build, test, and lint also build dependency artifacts. Published archives already include `dist`; consumers do not need the workspace or TypeScript compiler.
