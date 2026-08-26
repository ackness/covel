import assert from "node:assert/strict";
import { resolveSystemProxyRequest } from "./system-proxy.js";

const message = {
  type: "covel:system-proxy:resolve",
  version: 1,
  requestId: "request-1",
  url: "https://provider.example/v1/models",
};
const response = await resolveSystemProxyRequest(
  message,
  async () => "PROXY 127.0.0.1:7890; DIRECT",
);
assert.deepEqual(response, {
  type: "covel:system-proxy:resolved",
  version: 1,
  requestId: "request-1",
  result: "PROXY 127.0.0.1:7890; DIRECT",
});
assert.equal(
  await resolveSystemProxyRequest(
    { ...message, url: "file:///tmp/a" },
    async () => "DIRECT",
  ),
  undefined,
);
