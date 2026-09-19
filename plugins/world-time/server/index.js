import createAdvanceWorldTime from "../tools/advance-world-time.js";
import time from "../rpc/time.js";

export default function register(covel) {
  covel.registerTool(createAdvanceWorldTime(covel.toolkit));
  covel.registerRpc("time", time, {
    description: "Read committed world time without advancing it",
  });
}
