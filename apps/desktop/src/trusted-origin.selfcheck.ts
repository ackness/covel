/**
 * Runnable self-check for the origin-trust boundary. No test framework —
 * `tsx src/trusted-origin.selfcheck.ts` throws on the first failing assertion.
 */
import assert from "node:assert/strict";
import { isSameTrustedOrigin, loopbackHttpOrigin } from "./trusted-origin.js";

// loopbackHttpOrigin: only loopback http gets an origin back.
assert.equal(
  loopbackHttpOrigin("http://127.0.0.1:3001/session"),
  "http://127.0.0.1:3001",
);
assert.equal(
  loopbackHttpOrigin("http://localhost:5173/x"),
  "http://localhost:5173",
);
assert.equal(loopbackHttpOrigin("http://[::1]:80/"), "http://[::1]");
assert.equal(loopbackHttpOrigin("https://127.0.0.1:3001/"), null); // https not loopback-http
assert.equal(loopbackHttpOrigin("http://evil.com/"), null);
assert.equal(loopbackHttpOrigin("http://169.254.169.254/"), null); // link-local metadata
assert.equal(loopbackHttpOrigin("data:text/html,x"), null);
assert.equal(loopbackHttpOrigin("file:///etc/passwd"), null);
assert.equal(loopbackHttpOrigin(undefined), null);
assert.equal(loopbackHttpOrigin("not a url"), null);

// isSameTrustedOrigin: same loopback origin allowed, everything else refused.
const app = "http://127.0.0.1:3001/session";
assert.equal(
  isSameTrustedOrigin(app, "http://127.0.0.1:3001/session/other"),
  true,
);
assert.equal(isSameTrustedOrigin(app, "http://127.0.0.1:9999/"), false); // different port
assert.equal(isSameTrustedOrigin(app, "http://localhost:3001/"), false); // different host
assert.equal(isSameTrustedOrigin(app, "https://attacker.example/"), false);
assert.equal(isSameTrustedOrigin(app, "http://attacker.example/"), false);
assert.equal(isSameTrustedOrigin(app, "data:text/html,x"), false);
// Fail-closed when the trusted page itself is not a loopback-http origin
// (e.g. the data: splash is committed) — nothing is trusted.
assert.equal(isSameTrustedOrigin("data:text/html,splash", app), false);
assert.equal(isSameTrustedOrigin(undefined, app), false);

console.log("trusted-origin selfcheck: OK");
