import createAdvanceWorldTime from "../tools/advance-world-time.js";

export default function register(covel) {
  covel.registerTool(createAdvanceWorldTime(covel.toolkit));
}
