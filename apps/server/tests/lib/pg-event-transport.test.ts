import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresMocks = vi.hoisted(() => ({
  listen: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => postgresMocks),
}));

import { createPgEventTransport } from "../../src/lib/pg-event-transport.js";

describe("PgEventTransport", () => {
  beforeEach(() => {
    postgresMocks.listen.mockClear();
    postgresMocks.notify.mockReset().mockResolvedValue(undefined);
    postgresMocks.end.mockClear();
  });

  it("rejects publish when PostgreSQL NOTIFY fails", async () => {
    const failure = new Error("notify unavailable");
    postgresMocks.notify.mockRejectedValueOnce(failure);
    const transport = await createPgEventTransport("postgres://test");

    await expect(transport.publish("frame")).rejects.toBe(failure);
  });
});
