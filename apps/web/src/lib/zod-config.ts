import { z } from "zod";

// Zod compiles object parsers with `new Function` when it may, and finds out
// by trying once. The page policy allows no `eval`, so the try is a policy
// violation on every load. Tell Zod not to try. The build puts this module in
// Zod's own chunk (`manualChunks` in vite.config.ts), so it runs before any
// chunk that builds a schema.
z.config({ jitless: true });
