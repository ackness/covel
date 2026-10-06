import base from "../../vitest.base.js";

// The shared time limits apply here too: the PostgreSQL files create and drop
// a real database, and a drop that waits for a checkpoint or retries takes
// longer than Vitest's default of 10 s for a hook on a loaded machine.
export default {
  ...base,
  test: {
    ...base.test,
    fileParallelism: false,
  },
};
