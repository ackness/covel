// Named with its real extension: a plugin's relative imports are not mapped
// from `.js` to `.ts`.
import base from "../../vitest.base.ts";

export default {
  ...base,
  test: {
    ...base.test,
    include: ["tests/**/*.test.{js,ts}"],
  },
};
