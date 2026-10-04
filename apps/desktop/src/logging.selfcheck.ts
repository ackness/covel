import assert from "node:assert/strict";
import { classifyServerStreamLine, formatLogPart } from "./logging.js";

assert.match(
  formatLogPart(new Error("unsupported settings schemaVersion: 1")),
  /unsupported settings schemaVersion: 1/,
);
assert.equal(formatLogPart({ port: 3001 }), '{"port":3001}');

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
