import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createPgAdvisorySessionLock } from "../../src/lib/pg-session-lock.js";

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

function pool(cluster = new Map<string, symbol>()) {
  const connections: Array<{
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const reserve = vi.fn(async () => {
    const owner = Symbol("connection");
    const query = vi.fn(async (strings: TemplateStringsArray, key: string) => {
      if (strings.join("").includes("pg_try_advisory_lock")) {
        if (cluster.has(key) && cluster.get(key) !== owner)
          return [{ locked: false }];
        cluster.set(key, owner);
        return [{ locked: true }];
      }
      if (cluster.get(key) === owner) cluster.delete(key);
      return [];
    });
    const release = vi.fn();
    connections.push({ query, release });
    return Object.assign(query, { release });
  });
  return { sql: { reserve } as unknown as Sql, reserve, connections, cluster };
}

describe("PostgreSQL nonblocking session lock", () => {
  it("returns busy after one attempt against another owner and returns its connection", async () => {
    const cluster = new Map<string, symbol>();
    const a = pool(cluster);
    const b = pool(cluster);
    const owner = createPgAdvisorySessionLock(a.sql);
    const probe = createPgAdvisorySessionLock(b.sql);
    const entered = gate();
    const release = gate();
    const held = owner.withLock("session", async () => {
      entered.release();
      await release.promise;
    });
    await entered.promise;
    const callback = vi.fn(async () => 42);
    expect(await probe.tryWithLock!("session", callback)).toEqual({
      acquired: false,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(b.connections[0]!.query).toHaveBeenCalledTimes(1);
    expect(b.connections[0]!.release).toHaveBeenCalledOnce();
    release.release();
    await held;
    expect(await probe.tryWithLock!("session", callback)).toEqual({
      acquired: true,
      value: 42,
    });
    expect(b.connections[1]!.query).toHaveBeenCalledTimes(2);
    expect(b.connections[1]!.release).toHaveBeenCalledOnce();
  });

  it("reenters its owner and reuses the reserved connection for an additional key", async () => {
    const backend = pool();
    const lock = createPgAdvisorySessionLock(backend.sql);
    await lock.withLock("outer", async () => {
      expect(await lock.tryWithLock!("outer", async () => 1)).toEqual({
        acquired: true,
        value: 1,
      });
      expect(await lock.tryWithLock!("inner", async () => 2)).toEqual({
        acquired: true,
        value: 2,
      });
    });
    expect(backend.reserve).toHaveBeenCalledOnce();
    expect(backend.connections[0]!.query).toHaveBeenCalledTimes(4);
    expect(backend.cluster.size).toBe(0);
  });

  it("excludes sibling probes even though PostgreSQL allows same-connection reentry", async () => {
    const backend = pool();
    const lock = createPgAdvisorySessionLock(backend.sql);
    const entered = gate();
    const release = gate();
    await lock.withLock("outer", async () => {
      const first = lock.tryWithLock!("inner", async () => {
        entered.release();
        await release.promise;
      });
      await entered.promise;
      const callback = vi.fn(async () => 42);
      expect(await lock.tryWithLock!("inner", callback)).toEqual({
        acquired: false,
      });
      expect(callback).not.toHaveBeenCalled();
      release.release();
      await first;
    });
    expect(backend.reserve).toHaveBeenCalledOnce();
    expect(backend.connections[0]!.query).toHaveBeenCalledTimes(4);
  });

  it("unlocks and returns the connection when the callback throws", async () => {
    const backend = pool();
    const lock = createPgAdvisorySessionLock(backend.sql);
    await expect(
      lock.tryWithLock!("session", async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    expect(backend.connections[0]!.release).toHaveBeenCalledOnce();
    expect(backend.cluster.size).toBe(0);
    expect(await lock.tryWithLock!("session", async () => "recovered")).toEqual(
      { acquired: true, value: "recovered" },
    );
  });

  it("does not wait for an exhausted pool and releases a late checkout", async () => {
    const backend = pool();
    const connection = await backend.reserve();
    const releaseCheckout = gate();
    backend.reserve.mockImplementationOnce(async () => {
      await releaseCheckout.promise;
      return connection;
    });
    const lock = createPgAdvisorySessionLock(backend.sql);
    const callback = vi.fn(async () => 42);
    expect(await lock.tryWithLock!("session", callback)).toEqual({
      acquired: false,
    });
    releaseCheckout.release();
    await vi.waitFor(() => expect(connection.release).toHaveBeenCalledOnce());
    expect(callback).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
  });

  it("keeps the probe's connection and key until already-started nested work settles", async () => {
    const backend = pool();
    const lock = createPgAdvisorySessionLock(backend.sql);
    const entered = gate();
    const release = gate();
    let nested!: Promise<void>;
    const probe = lock.tryWithLock!("outer", async () => {
      nested = lock.withLock("inner", async () => {
        entered.release();
        await release.promise;
      });
      await entered.promise;
      return 42;
    });
    await entered.promise;
    expect(backend.cluster.size).toBe(2);
    expect(backend.connections[0]!.release).not.toHaveBeenCalled();
    release.release();
    expect(await probe).toEqual({ acquired: true, value: 42 });
    await nested;
    expect(backend.cluster.size).toBe(0);
    expect(backend.connections[0]!.release).toHaveBeenCalledOnce();
  });
});
