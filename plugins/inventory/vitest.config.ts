// Named with its real extension: a plugin's relative imports are not mapped
// from `.js` to `.ts`.
import { useRunTempDir } from "../../vitest.base.ts";

// The run gets a temp directory of its own, removed when it ends.
useRunTempDir();

export default {};
