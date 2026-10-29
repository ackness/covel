// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("limits the requests in progress and ignores a repeated id", async () => {
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
    await vi.waitFor(() => expect(connection.received).toHaveLength(9));
    expect(
      connection.received
        .slice(1)
        .map((message) => (message as { id: string }).id)
        .sort(),
    ).toEqual(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    connection.bridge.close();
  });
});

it("posts only nonempty stream appends with a positive integer sequence", async () => {
  const connection = connect();
  await connection.next();
  connection.bridge.pushStream(0, "bad");
  connection.bridge.pushStream(1.5, "bad");
  connection.bridge.pushStream(3, "");
  connection.bridge.pushStream(3, "ab");
  expect(await connection.next()).toEqual({
    type: "stream",
    seq: 3,
    append: "ab",
  });
  expect(connection.received).toHaveLength(2);
  connection.bridge.close();
});

it("the page bridge merges appends and ignores the stream lane without consented session state", async () => {
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
  const source = pluginFrameDocument("").match(
    /<script>([\s\S]*?)<\/script>/,
  )?.[1];
  runInNewContext(source!, {
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
      value: { session: { version: 1, streaming: { seq: 2, text: "a" } } },
    },
  });
  port.onmessage?.({ data: { type: "stream", seq: 2, append: "b" } });
  expect(page.covel?.getState()).toMatchObject({
    session: { streaming: { seq: 2, text: "ab" } },
  });
  port.onmessage?.({ data: { type: "stream", seq: 3, append: "c" } });
  expect(page.covel?.getState()).toMatchObject({
    session: { streaming: { seq: 3, text: "c" } },
  });
  expect(notify).toHaveBeenCalledTimes(3);
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
