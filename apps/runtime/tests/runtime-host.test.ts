import { describe, expect, it } from "vitest";

import { resolveRuntimeListenConfig } from "../src/runtime-host.js";

describe("resolveRuntimeListenConfig", () => {
  it("binds runtime to loopback by default", () => {
    expect(resolveRuntimeListenConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8787
    });
  });

  it("allows explicit host and port overrides", () => {
    expect(resolveRuntimeListenConfig({
      HOST: "0.0.0.0",
      PORT: "9011"
    })).toEqual({
      host: "0.0.0.0",
      port: 9011
    });
  });
});
