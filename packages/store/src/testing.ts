/**
 * Test-only entry: the record builders the shared store contract suites use,
 * so other workspaces' tests build rows the same way without reaching into
 * `src/contract/`. Production code must not import it.
 */
export * from "./contract/test-fixtures.js";
