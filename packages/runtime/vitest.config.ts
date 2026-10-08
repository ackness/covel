import base from "../../vitest.base.js";

export default {
  test: {
    ...base.test,
    coverage: {
      ...base.test.coverage,
      // Checked only when coverage is collected (`pnpm test:coverage:runtime`,
      // which CI runs). A floor a few points under the measured values, to
      // catch a drop; raise it when coverage rises.
      thresholds: { lines: 88, statements: 86, functions: 87, branches: 80 },
    },
  },
};
