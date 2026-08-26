import { describe, expect, it } from "vitest";
import { resolveStorageStatus } from "../right-panel.js";

describe("right-panel storage status", () => {
  it("treats browser-local IndexedDB as authoritative over the Memory mirror", () => {
    expect(
      resolveStorageStatus({ backend: "memory", frontendMode: "local" }),
    ).toEqual({
      browserAuthority: true,
      backend: "memory",
    });
  });

  it.each(["sqlite", "pg"] as const)(
    "keeps remote %s durable without a restart warning",
    (backend) => {
      expect(resolveStorageStatus({ backend, frontendMode: "remote" })).toEqual(
        {
          browserAuthority: false,
          backend,
        },
      );
    },
  );

  it("keeps the remote Memory restart warning", () => {
    expect(
      resolveStorageStatus({ backend: "memory", frontendMode: "remote" }),
    ).toEqual({
      browserAuthority: false,
      backend: "memory",
    });
  });
});
