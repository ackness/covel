// Named with its real extension: a plugin's relative imports are not mapped
// from `.js` to `.ts`.
import { useRunTempDir } from "../../vitest.base.ts";
import { fileURLToPath } from "node:url";

// The run gets a temp directory of its own, removed when it ends.
useRunTempDir();

export default {
  resolve: {
    // Public workspace entry points for real-manifest commit tests. Test-only
    // aliases avoid adding dependencies that would require a lockfile change.
    alias: {
      "@covel/runtime": fileURLToPath(
        new URL("../../packages/runtime/src/index.ts", import.meta.url),
      ),
      "@covel/store/memory": fileURLToPath(
        new URL("../../packages/store/src/memory-entry.ts", import.meta.url),
      ),
    },
  },
};
