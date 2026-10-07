import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  fetchWithTimeout,
  findPreferredPort,
  MAX_POLL_INTERVAL_MS,
  parseStoredPort,
  waitForServer,
} from "./network.js";

const neverResponds = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  })) as typeof fetch;

const started = Date.now();
await assert.rejects(
  fetchWithTimeout("http://127.0.0.1/hung", 20, neverResponds),
  (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
);
assert.ok(Date.now() - started < 1_000);

// server.port holds one port; anything else names no port to prefer.
assert.equal(parseStoredPort("53211"), 53211);
assert.equal(parseStoredPort(" 53211\n"), 53211);
assert.equal(parseStoredPort(""), undefined);
assert.equal(parseStoredPort("80"), undefined);
assert.equal(parseStoredPort("65536"), undefined);
assert.equal(parseStoredPort("53211 53212"), undefined);
assert.equal(parseStoredPort("0x1f90"), undefined);
assert.equal(parseStoredPort(undefined), undefined);

// The previous port is kept while it can be bound, so the page origin (and
// the browser storage behind it) is the same on the next launch.
const occupied = createServer();
occupied.listen(0, "127.0.0.1");
await once(occupied, "listening");
const address = occupied.address();
assert.ok(address && typeof address === "object");
const takenPort = address.port;
try {
  // Another process holds it: fall back to a different, free port.
  const fallback = await findPreferredPort(takenPort);
  assert.notEqual(fallback, takenPort);
  assert.ok(fallback >= 1024);
} finally {
  occupied.close();
  await once(occupied, "close");
}
assert.equal(await findPreferredPort(takenPort), takenPort);
// No previous launch: any free port.
assert.ok((await findPreferredPort(undefined)) >= 1024);

// Readiness polling never waits longer than the cap between two requests,
// however long the server takes: the wait after it is able to answer stays
// short. Sleeps are recorded, not waited for.
const waits: number[] = [];
let requests = 0;
const readyOnTwelfthRequest = (async () => {
  requests += 1;
  return new Response(null, { status: requests >= 12 ? 200 : 503 });
}) as typeof fetch;
await waitForServer(
  "http://127.0.0.1/health",
  30_000,
  150,
  undefined,
  async (ms) => {
    waits.push(ms);
  },
  readyOnTwelfthRequest,
);
assert.equal(requests, 12);
assert.equal(waits.length, 11);
assert.equal(waits[0], 150);
assert.equal(Math.max(...waits), MAX_POLL_INTERVAL_MS);

console.log("network selfcheck: OK");
