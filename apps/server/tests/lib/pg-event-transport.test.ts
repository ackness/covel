import { beforeEach, describe, expect, it, vi } from "vitest";

const postgresMocks = vi.hoisted(() => ({
  listen: vi.fn(
    async (_channel: string, _handler: (payload: string) => void) => undefined,
  ),
  notify: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
}));

vi.mock("postgres", () => ({
  default: vi.fn(() => postgresMocks),
}));

import { createPgEventTransport } from "../../src/lib/pg-event-transport.js";

describe("PgEventTransport", () => {
  beforeEach(() => {
    postgresMocks.listen.mockReset().mockResolvedValue(undefined);
    postgresMocks.notify.mockReset().mockResolvedValue(undefined);
    postgresMocks.end.mockClear();
  });

  it("rejects publish when PostgreSQL NOTIFY fails", async () => {
    const failure = new Error("notify unavailable");
    postgresMocks.notify.mockRejectedValueOnce(failure);
    const transport = await createPgEventTransport("postgres://test");

    await expect(transport.publish("frame")).rejects.toBe(failure);
    await transport.close();
  });

  it("releases connections once and unsubscribes handlers", async () => {
    const transport = await createPgEventTransport("postgres://test");
    const handler = vi.fn();
    const unsubscribe = transport.subscribe(handler);
    const receive = postgresMocks.listen.mock.calls[0]![1] as (
      payload: string,
    ) => void;
    receive("first");
    if (unsubscribe) unsubscribe();
    receive("second");
    expect(handler).toHaveBeenCalledExactlyOnceWith("first");
    await Promise.all([transport.close(), transport.close()]);
    expect(postgresMocks.end).toHaveBeenCalledOnce();
  });

  it("closes its client when LISTEN fails during initialization", async () => {
    const failure = new Error("listen failed");
    postgresMocks.listen.mockRejectedValueOnce(failure);
    await expect(createPgEventTransport("postgres://test")).rejects.toBe(
      failure,
    );
    expect(postgresMocks.end).toHaveBeenCalledOnce();
  });
});
