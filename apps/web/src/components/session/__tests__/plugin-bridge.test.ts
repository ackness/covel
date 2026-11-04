// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_BRIDGE_SCRIPT } from "@covel/shared";
import {
  connectPluginBridge,
  pluginFrameDocument,
  type PluginBridge,
  type PluginBridgeHost,
} from "../plugin-bridge.js";

interface Connection {
  bridge: PluginBridge;
  /** The frame's end of the channel. */
  port: MessagePort;
  posted: { message: unknown; targetOrigin: string }[];
  received: unknown[];
  next(): Promise<unknown>;
}

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

function connect(host: Partial<PluginBridgeHost> = {}): Connection {
  const posted: Connection["posted"] = [];
  const received: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  let port: MessagePort | undefined;
  const bridge = connectPluginBridge(
    {
      postMessage: (
        message: unknown,
        targetOrigin: string,
        transfer: MessagePort[],
      ) => {
        posted.push({ message, targetOrigin });
        port = transfer[0];
      },
    } as unknown as Pick<Window, "postMessage">,
    "<p>plugin</p>",
    () => ({ state: {}, locked: false, handlers: {}, ...host }),
  );
  if (!port) throw new Error("no port was transferred to the frame");
  port.onmessage = ({ data }) => {
    received.push(data);
    waiting.shift()?.(data);
  };
  open.push(port);
  return {
    bridge,
    port,
    posted,
    received,
    next: () => new Promise((resolve) => waiting.push(resolve)),
  };
}

const failed = (id: string) => ({
  type: "result",
  id,
  error: "Plugin UI action failed",
});

describe("connectPluginBridge", () => {
  it("hands the frame its document and the only port, then the state", async () => {
    const connection = connect({ state: { data: { a: 1 } } });
    expect(connection.posted).toEqual([
      {
        message: {
          type: "covel:connect",
          document: pluginFrameDocument("<p>plugin</p>"),
        },
        targetOrigin: "*",
      },
    ]);
    expect(await connection.next()).toEqual({
      type: "state",
      value: { data: { a: 1 } },
    });
    connection.bridge.close();
  });

  it("calls only a handler the host offers, with the parameters as sent", async () => {
    const refresh = vi.fn(async () => ({ status: "ok" }));
    const connection = connect({ handlers: { refresh } });
    await connection.next();
    connection.port.postMessage({
      type: "action",
      id: "1",
      action: "refresh",
      params: { limit: 3 },
    });
    expect(await connection.next()).toEqual({
      type: "result",
      id: "1",
      value: { status: "ok" },
    });
    expect(refresh).toHaveBeenCalledWith({ limit: 3 });

    for (const action of ["missing", "constructor", "__proto__", "toString"]) {
      connection.port.postMessage({
        type: "action",
        id: action,
        action,
        params: {},
      });
      expect(await connection.next()).toEqual(failed(action));
    }
    connection.bridge.close();
  });

  it("answers malformed requests with the fixed failure", async () => {
    const run = vi.fn();
    const connection = connect({ handlers: { run } });
    await connection.next();
    const bad: Record<string, unknown>[] = [
      { action: "run" },
      { action: "run", params: null },
      { action: "run", params: [1] },
      { action: "run", params: "text" },
      { action: 7, params: {} },
      { action: "", params: {} },
      { action: "x".repeat(121), params: {} },
    ];
    for (const [index, body] of bad.entries()) {
      const id = `bad-${index}`;
      connection.port.postMessage({ type: "action", id, ...body });
      expect(await connection.next()).toEqual(failed(id));
    }
    expect(run).not.toHaveBeenCalled();
    connection.bridge.close();
  });

  it("drops what it cannot answer", async () => {
    const run = vi.fn(() => "done");
    const connection = connect({ handlers: { run } });
    await connection.next();
    const request = { action: "run", params: {} };
    for (const message of [
      null,
      "action",
      42,
      [],
      { ...request, id: "1" },
      { ...request, type: "result", id: "1" },
      { ...request, type: "action" },
      { ...request, type: "action", id: 1 },
      { ...request, type: "action", id: "" },
      { ...request, type: "action", id: "x".repeat(81) },
    ])
      connection.port.postMessage(message);
    connection.port.postMessage({ ...request, type: "action", id: "last" });
    expect(await connection.next()).toEqual({
      type: "result",
      id: "last",
      value: "done",
    });
    expect(connection.received).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(1);
    connection.bridge.close();
  });

  it("refuses every action while the host is locked", async () => {
    const run = vi.fn();
    const connection = connect({ handlers: { run }, locked: true });
    await connection.next();
    connection.port.postMessage({
      type: "action",
      id: "1",
      action: "run",
      params: {},
    });
    expect(await connection.next()).toEqual(failed("1"));
    expect(run).not.toHaveBeenCalled();
    connection.bridge.close();
  });

  it("never passes a handler's error text to the frame", async () => {
    const connection = connect({
      handlers: {
        run: async () => {
          throw new Error("401 from provider: Bearer sk-secret-value");
        },
      },
    });
    await connection.next();
    connection.port.postMessage({
      type: "action",
      id: "1",
      action: "run",
      params: {},
    });
    const answer = await connection.next();
    expect(answer).toEqual(failed("1"));
    expect(JSON.stringify(answer)).not.toContain("sk-secret-value");
    connection.bridge.close();
  });

  it("limits requests in progress and refuses repeated IDs", async () => {
    const release: (() => void)[] = [];
    const run = vi.fn(
      () => new Promise<string>((resolve) => release.push(() => resolve("ok"))),
    );
    const connection = connect({ handlers: { run } });
    await connection.next();
    const send = (id: string) =>
      connection.port.postMessage({
        type: "action",
        id,
        action: "run",
        params: {},
      });
    for (let index = 0; index < 8; index += 1) send(`r${index}`);
    send("r0");
    send("over");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(8));
    // Messages are delivered in order, so the two extra ones were seen too.
    send("r0");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledTimes(8);
    for (const done of release) done();
    await vi.waitFor(() => expect(connection.received).toHaveLength(11));
    expect(
      connection.received
        .slice(1)
        .filter((message) => (message as { value?: unknown }).value === "ok")
        .map((message) => (message as { id: string }).id)
        .sort(),
    ).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    connection.bridge.close();
  });
});

it("provides complete state delivery without a stream sender", async () => {
  const connection = connect();
  await connection.next();
  expect(connection.bridge).not.toHaveProperty("pushStream");
  connection.bridge.pushState({ public: "Full story" });
  expect(await connection.next()).toMatchObject({
    type: "state",
    value: { public: "Full story" },
  });
  connection.bridge.close();
});

it("the page bridge rejects older versions and accepts only complete version four session state", async () => {
  const { runInNewContext } = await import("node:vm");
  let listener: ((event: unknown) => void) | undefined;
  const page: {
    covel?: {
      getState(): Record<string, unknown>;
      subscribe(listener: (state: unknown) => void): void;
    };
  } = {};
  const parent = {};
  const port = {
    start: vi.fn(),
    postMessage: vi.fn(),
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
  };
  // Run the exact script the frame document embeds, without parsing HTML.
  const source = PLUGIN_BRIDGE_SCRIPT;
  expect(pluginFrameDocument("")).toContain(`<script>${source}</script>`);
  runInNewContext(source, {
    window: page,
    parent,
    document: {},
    addEventListener: (_: string, callback: typeof listener) => {
      listener = callback;
    },
  });
  listener?.({
    source: parent,
    data: { type: "covel:connect" },
    ports: [port],
  });
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
  const notify = vi.fn();
  page.covel?.subscribe(notify);
  notify.mockClear();
  port.onmessage?.({ data: { type: "stream", seq: 1, append: "private" } });
  expect(page.covel?.getState()).toEqual({});
  expect(notify).not.toHaveBeenCalled();
  port.onmessage?.({
    data: {
      type: "state",
      value: { session: { version: 2, streaming: { seq: 2, text: "a" } } },
    },
  });
  expect(page.covel?.getState()).toEqual({});
  expect(notify).not.toHaveBeenCalled();
  port.onmessage?.({
    data: { type: "state", value: { session: { version: 3, messages: [] } } },
  });
  expect(page.covel?.getState()).toEqual({});
  expect(notify).not.toHaveBeenCalled();
  port.onmessage?.({
    data: {
      type: "state",
      value: {
        session: { version: 4, messages: [{ seq: 2, text: "Full story" }] },
      },
    },
  });
  port.onmessage?.({ data: { type: "stream", seq: 2, append: "PRIVATE" } });
  expect(page.covel?.getState()).toMatchObject({
    session: { version: 4, messages: [{ seq: 2, text: "Full story" }] },
  });
  expect(notify).toHaveBeenCalledOnce();
});

it("connects URL pages without a document and handles ready separately from actions", async () => {
  const posted = vi.fn();
  const ready = vi.fn();
  let transferred: MessagePort | undefined;
  const bridge = connectPluginBridge(
    {
      postMessage: (message: unknown, origin: string, ports: MessagePort[]) => {
        posted(message, origin);
        transferred = ports[0];
      },
    } as unknown as Pick<Window, "postMessage">,
    undefined,
    () => ({ state: {}, locked: false, handlers: {} }),
    { onReady: ready },
  );
  if (!transferred) throw new Error("missing port");
  open.push(transferred);
  expect(posted).toHaveBeenCalledExactlyOnceWith(
    { type: "covel:connect" },
    "*",
  );
  const port = transferred;
  const received: unknown[] = [];
  port.onmessage = (event) => received.push(event.data);
  port.postMessage({ type: "unknown" });
  port.postMessage({ type: "ready" });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(received).toEqual([{ type: "state", value: {} }]);
  bridge.close();
});

it("never executes a completed request ID again and enforces the byte bound", async () => {
  const run = vi.fn(() => "ok");
  const c = connect({ handlers: { run } });
  await c.next();
  const request = { type: "action", id: "once", action: "run", params: {} };
  c.port.postMessage(request);
  await c.next();
  c.port.postMessage(request);
  expect(await c.next()).toEqual(failed("once"));
  c.port.postMessage({
    ...request,
    id: "large",
    params: { value: "字".repeat(50000) },
  });
  expect(await c.next()).toEqual(failed("large"));
  expect(run).toHaveBeenCalledOnce();
  c.bridge.close();
});
it("closes admission permanently when the per-connection ID budget is exhausted", async () => {
  const run = vi.fn(() => "ok");
  const c = connect({ handlers: { run } });
  await c.next();
  for (let index = 0; index < 4096; index++) {
    c.port.postMessage({
      type: "action",
      id: String(index),
      action: "run",
      params: {},
    });
    await c.next();
  }
  c.port.postMessage({ type: "action", id: "new", action: "run", params: {} });
  expect(await c.next()).toEqual(failed("new"));
  c.port.postMessage({ type: "action", id: "0", action: "run", params: {} });
  expect(await c.next()).toEqual(failed("0"));
  expect(run).toHaveBeenCalledTimes(4096);
  c.bridge.close();
});
it("drops late replies and delivery after retirement and validates every session outcome", async () => {
  let active = true;
  let finish!: (value: unknown) => void;
  const c = connect({
    sessionPage: true,
    isCurrent: () => active,
    locked: true,
    handlers: {
      abortExecution: () => ({ status: "accepted" }),
      raw: () => ({
        status: "accepted",
        result: { providerContinuation: "credential-sentinel" },
      }),
      slow: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  await c.next();
  c.port.postMessage({
    type: "action",
    id: "abort",
    action: "abortExecution",
    params: {},
  });
  expect(await c.next()).toEqual({
    type: "result",
    id: "abort",
    value: { status: "accepted" },
  });
  c.port.postMessage({ type: "action", id: "raw", action: "raw", params: {} });
  expect(await c.next()).toEqual(failed("raw"));
  c.port.postMessage({
    type: "action",
    id: "slow",
    action: "slow",
    params: {},
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  active = false;
  finish({ status: "committed" });
  c.bridge.pushState({ private: "credential-sentinel" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(c.received).toHaveLength(3);
  expect(JSON.stringify(c.received)).not.toContain("credential-sentinel");
  c.bridge.close();
});

it("executes the shipped page script against a real channel, reconstructs text and rejects promises on shutdown", async () => {
  const { runInNewContext } = await import("node:vm");
  let connectPage!: (event: unknown) => void;
  const parent = {};
  const page: {
    covel?: {
      getState(): { session?: { messages?: { seq: number; text: string }[] } };
      invoke(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown>;
    };
  } = {};
  const captured: unknown[] = [];
  runInNewContext(PLUGIN_BRIDGE_SCRIPT, {
    window: page,
    parent,
    document: { documentElement: { style: { setProperty() {} }, dataset: {} } },
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, callback: (event: unknown) => void) => {
      if (type === "message") connectPage = callback;
    },
  });
  let finish!: () => void;
  const bridge = connectPluginBridge(
    {
      postMessage: (
        _message: unknown,
        _origin: string,
        ports: MessagePort[],
      ) => {
        const port = ports[0]!;
        open.push(port);
        connectPage({
          source: parent,
          data: { type: "covel:connect" },
          ports: [port],
        });
        const deliver = port.onmessage!;
        port.onmessage = (event) => {
          captured.push(event.data);
          deliver.call(port, event);
        };
      },
    } as unknown as Pick<Window, "postMessage">,
    undefined,
    () => ({
      state: { session: { version: 4, messages: [] } },
      sessionPage: true,
      locked: false,
      handlers: {
        run: () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                status: "committed",
                output: { credential: "credential-sentinel" },
              });
          }),
      },
    }),
  );
  await vi.waitFor(() => expect(page.covel?.getState().session).toBeDefined());
  const expected = "字🙂".repeat(50);
  bridge.pushState({
    session: { version: 4, messages: [{ seq: 1, text: expected }] },
  });
  await vi.waitFor(() =>
    expect(page.covel?.getState().session?.messages?.[0]?.text).toBe(expected),
  );
  expect(
    captured.some((value) => (value as { type: string }).type === "stream"),
  ).toBe(false);
  const pending = Array.from({ length: 8 }, () => page.covel!.invoke("run"));
  for (const promise of pending) void promise.catch(() => {});
  await expect(page.covel!.invoke("run")).rejects.toThrow("Plugin UI is busy");
  bridge.close();
  await Promise.all(
    pending.map((promise) =>
      expect(promise).rejects.toThrow("Plugin UI is not connected"),
    ),
  );
  finish?.();
  expect(JSON.stringify(captured)).not.toContain("credential-sentinel");
  expect(captured).toContainEqual({ type: "closed" });
});

it.each(["error", "unhandledrejection"])(
  "executes the page lifecycle protocol for %s without transmitting private details",
  async (eventType) => {
    const { runInNewContext } = await import("node:vm");
    const events = new Map<string, (event: unknown) => void>();
    const parent = {};
    const page = {};
    runInNewContext(PLUGIN_BRIDGE_SCRIPT, {
      window: page,
      parent,
      document: {},
      addEventListener: (type: string, callback: (event: unknown) => void) =>
        events.set(type, callback),
    });
    const port = {
      start: vi.fn(),
      postMessage: vi.fn(),
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    };
    events.get("message")?.({
      source: parent,
      data: { type: "covel:connect" },
      ports: [port],
    });
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
    port.onmessage?.({ data: { type: "ping", id: 7 } });
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: "pong", id: 7 });
    port.postMessage.mockClear();
    events.get(eventType)?.({
      message: "private-error",
      reason: "credential",
      filename: "private-file",
    });
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "page-error",
    });
  },
);

it("does not report normal pagehide as a page error", async () => {
  const { runInNewContext } = await import("node:vm");
  const events = new Map<string, (event: unknown) => void>();
  const parent = {};
  runInNewContext(PLUGIN_BRIDGE_SCRIPT, {
    window: {},
    parent,
    document: {},
    addEventListener: (type: string, callback: (event: unknown) => void) =>
      events.set(type, callback),
  });
  const port = { start: vi.fn(), postMessage: vi.fn() };
  events.get("message")?.({
    source: parent,
    data: { type: "covel:connect" },
    ports: [port],
  });
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ready" });
  port.postMessage.mockClear();
  events.get("pagehide")?.({ persisted: false });
  expect(port.postMessage).not.toHaveBeenCalled();
  events.get("unhandledrejection")?.({ reason: "private-rejection" });
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "page-error",
  });
});
