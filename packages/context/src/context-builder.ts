/** Public entrypoint for runtime prompt assembly. */
export { buildContext } from "./prompt-assembler.js";
export {
  interpolateTemplate,
  resolveFrameworkCompletion,
} from "./prompt-internals.js";
