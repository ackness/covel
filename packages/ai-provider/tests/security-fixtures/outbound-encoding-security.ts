import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { brotliCompressSync } from "node:zlib";
import { postJson, readResponseJson } from "../../src/adapters/http.js";
import {
  OUTBOUND_TEST_FETCH_HOOK,
  resetOutboundProxyForTests,
} from "../../src/outbound-network.js";

async function main(): Promise<void> {
  // No Vitest setup or fetch replacement: postJson must use production npm
  // Undici, even though the parent test runs with NODE_ENV=test.
  assert.equal(Reflect.get(globalThis, OUTBOUND_TEST_FETCH_HOOK), undefined);

  const earlyClose = Promise.withResolvers<void>();
  const requests: string[] = [];
  const payload = { ok: true, message: "Still serving legitimate responses" };
  const compressed = brotliCompressSync(JSON.stringify(payload));
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.once("end", () => {
      if (req.url === "/v1/malformed") {
        req.socket.once("close", () => earlyClose.resolve());
        // Send headers then FIN, with none of the declared body. Writing the
        // wire response directly avoids node:http completing or repairing it.
        // This is the early-close shape from the upstream security regression:
        // https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c
        req.socket.end(
          "HTTP/1.1 200 OK\r\n" +
            `Content-Encoding: ${Array(6).fill("gzip").join(", ")}\r\n` +
            "Content-Length: 1\r\n" +
            "Connection: close\r\n\r\n",
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "br",
        "content-length": String(compressed.byteLength),
        connection: "close",
      });
      res.end(compressed);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const config = { baseUrl: `http://127.0.0.1:${port}` };

  try {
    // Catch only the request rejection. In particular, do not install an
    // uncaughtException/unhandledRejection handler: orphaned stream errors
    // must still kill this child and fail the parent test on vulnerable builds.
    await assert.rejects(
      postJson(config, "/malformed", {}),
      /content-encoding/,
    );
    await earlyClose.promise;
    await setImmediate();

    // Same process, server and outbound dispatcher after the malformed reply.
    // Decode a real, valid Brotli body through Covel's bounded JSON reader.
    const response = await postJson(config, "/healthy", {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.deepEqual(await readResponseJson(response), payload);
    assert.deepEqual(requests, ["POST /v1/malformed", "POST /v1/healthy"]);
    assert.equal(server.listening, true);
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close((error) => {
      if (error) closed.reject(error);
      else closed.resolve();
    });
    await Promise.all([closed.promise, resetOutboundProxyForTests()]);
  }

  // Success is observed only after cleanup; the parent also requires a natural
  // zero exit, so a late unhandled error cannot hide behind this marker.
  console.log("outbound encoding security passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
