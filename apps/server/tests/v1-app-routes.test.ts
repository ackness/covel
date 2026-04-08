import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("V1 routes mounted on app", () => {
  it("serves V1 runtime listing route from the main app", async () => {
    const res = await app.request("/api/sessions/v1-mount-check/runtimes");
    expect(res.status).not.toBe(404);
  });
});
