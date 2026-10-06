import base from "../../vitest.base.js";

// The shared time limits, with the tests kept beside the sources.
export default {
  test: { ...base.test, include: ["src/**/*.test.ts"] },
};
