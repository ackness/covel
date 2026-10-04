import assert from "node:assert/strict";
import { classifyServerStreamLine, formatLogPart } from "./logging.js";

assert.match(
  formatLogPart(new Error("unsupported settings schemaVersion: 1")),
  /unsupported settings schemaVersion: 1/,
);
assert.equal(formatLogPart({ port: 3001 }), '{"port":3001}');
assert.match(
  formatLogPart(
    new Error("sidecar request failed", {
      cause: new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:5173"),
      }),
    }),
  ),
  /sidecar request failed[\s\S]*caused by TypeError: fetch failed[\s\S]*caused by Error: connect ECONNREFUSED 127\.0\.0\.1:5173/,
);

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
