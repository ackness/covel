import assert from "node:assert/strict";
import { classifyServerStreamLine } from "./logging.js";

assert.deepEqual(
  classifyServerStreamLine(
    "stderr",
    "[covel:warn] [turn-executor] same-layer effects hazard (policy: warn)",
  ),
  {
    level: "warn",
    source: "server.err",
    message: "[turn-executor] same-layer effects hazard (policy: warn)",
  },
);

assert.equal(
  classifyServerStreamLine("stderr", "fatal sidecar failure").level,
  "error",
);
assert.equal(
  classifyServerStreamLine("stdout", "server started").level,
  "info",
);

console.log("logging self-check passed");
