import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsStore, type SettingsStoreApi } from "@covel/settings";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hashPluginViewContent,
  pluginViewContent,
  sessionViewConsentKey,
  usePluginViewConsent,
} from "../plugin-view-consent.js";
import { useGameViewMode } from "../game-view/use-game-view-mode.js";
import { PluginViewHost } from "../plugin-view-host.js";
import { PluginWebview } from "../plugin-webview.js";
import type { StreamFeed } from "../session-bridge-stream.js";
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import {
  viewEntry,
  pageViewEntry,
  projection,
} from "./plugin-view-fixtures.js";
const mocks = vi.hoisted(() => ({
  store: undefined as SettingsStoreApi | undefined,
  posted: [] as unknown[],
  sessionBridge: vi.fn(),
  connections: [] as {
    states: unknown[];
    streams: { seq: number; append: string }[];
    close: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => mocks.store,
}));
vi.mock("../use-session-bridge.js", () => ({
  useSessionBridge: (sessionId: string) => mocks.sessionBridge(sessionId),
}));
vi.mock("../plugin-panel.js", () => ({
  PluginPanel: ({
    spec,
    sessionBridge,
  }: {
    spec: typeof viewEntry.spec;
    sessionBridge?: { projection: typeof projection; stream: StreamFeed };
  }) => (
    <PluginWebview
      title="Consented page"
      html={spec.webview?.html}
      src={spec.webview?.url}
      locked={false}
      handlers={{}}
      state={sessionBridge ? { session: sessionBridge.projection } : {}}
      stream={sessionBridge?.stream}
    />
  ),
}));
vi.mock("../plugin-bridge.js", () => ({
  connectPluginBridge: (
    _: unknown,
    __: unknown,
    host: () => { state: unknown },
  ) => {
    const initial = host().state;
    mocks.posted.push(initial);
    const connection = {
      states: [initial],
      streams: [] as { seq: number; append: string }[],
      close: vi.fn(),
    };
    mocks.connections.push(connection);
    return {
      pushState: (value: unknown) => {
        mocks.posted.push(value);
        connection.states.push(value);
      },
      pushStream: (seq: number, append: string) =>
        connection.streams.push({ seq, append }),
      close: connection.close,
    };
  },
}));
vi.mock("@/theme-system/use-theme-snapshot.js", () => ({
  useThemeSnapshot: () => ({ scheme: "light", tokens: {} }),
}));
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  mocks.posted = [];
  mocks.connections = [];
  mocks.sessionBridge.mockReset().mockReturnValue({
    projection,
    stream: { subscribe: () => () => {}, read: () => null },
  });
  const store = new SettingsStore({
    load: async () => ({}),
    save: async () => {},
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
  });
  await store.init();
  mocks.store = store;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("hashes canonical spec plus HTML and persists per-plugin, per-capability consent", async () => {
  const hash = await hashPluginViewContent(pluginViewContent(viewEntry.spec));
  expect(hash).toHaveLength(64);
  expect(
    await hashPluginViewContent(
      pluginViewContent({ ...viewEntry.spec, webview: { html: "changed" } }),
    ),
  ).not.toBe(hash);
  const { result, rerender } = renderHook(
    ({ entry }) => usePluginViewConsent([entry]),
    { initialProps: { entry: viewEntry } },
  );
  await waitFor(() => expect(result.current.ready(viewEntry)).toBe(true));
  expect(result.current.isAllowed(viewEntry)).toBe(false);
  await act(() => result.current.grant(viewEntry));
  expect(result.current.isAllowed(viewEntry)).toBe(true);
  expect(mocks.store?.get(sessionViewConsentKey("p", hash))).toBe(true);
  const other = {
    ...viewEntry,
    pluginId: "other",
    mode: "plugin:other:v" as const,
  };
  rerender({ entry: other });
  await waitFor(() => expect(result.current.ready(other)).toBe(true));
  expect(result.current.isAllowed(other)).toBe(false);
  const specChange = {
    ...viewEntry,
    spec: { ...viewEntry.spec, description: "Changed spec only" },
  };
  rerender({ entry: specChange });
  await waitFor(() => expect(result.current.ready(specChange)).toBe(true));
  expect(result.current.isAllowed(specChange)).toBe(false);
  const changed = {
    ...viewEntry,
    spec: { ...viewEntry.spec, webview: { html: "changed" } },
  };
  rerender({ entry: changed });
  expect(result.current.isAllowed(changed)).toBe(false);
  await waitFor(() => expect(result.current.ready(changed)).toBe(true));
  expect(result.current.isAllowed(changed)).toBe(false);
  await act(() => result.current.grant(changed));
  expect(result.current.isAllowed(changed)).toBe(true);
  await act(() => result.current.revoke(changed));
  expect(result.current.isAllowed(changed)).toBe(false);
});
it.each([viewEntry, pageViewEntry])(
  "a bridge world default falls back and posts no projection before the player consents ($spec.webview)",
  async (entry) => {
    function Host() {
      const consent = usePluginViewConsent([entry]);
      const [mode, , info] = useGameViewMode(
        { metadata: { defaultViewMode: entry.mode } },
        { views: [entry], status: "ready", reload: () => {} },
        consent.isAllowed,
      );
      return (
        <>
          <span data-testid="mode">{mode}</span>
          <button
            disabled={!consent.ready(entry)}
            onClick={() => void consent.grant(entry)}
          >
            Allow
          </button>
          {mode === entry.mode && (
            <PluginViewHost
              entry={entry}
              sessionId="s"
              sessionBridgeAllowed={consent.isAllowed(entry)}
              onFallback={() => {}}
            />
          )}
          {info.consentView && <p>Consent required</p>}
        </>
      );
    }
    render(<Host />);
    expect(screen.getByTestId("mode").textContent).toBe("parsed");
    await waitFor(() =>
      expect((screen.getByText("Allow") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByTitle("Consented page")).toBeNull();
    expect(mocks.posted).toEqual([]);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() =>
      expect(screen.getByTestId("mode").textContent).toBe(entry.mode),
    );
    fireEvent.load(screen.getByTitle("Consented page"));
    expect(mocks.posted).toEqual([
      expect.objectContaining({ session: projection }),
    ]);
  },
);
it("binds page consent to every published file through the URL digest", async () => {
  const entry = {
    ...viewEntry,
    spec: {
      ...viewEntry.spec,
      webview: { url: `/plugin-assets/p/${"a".repeat(32)}/index.html` },
    },
  };
  const changed = {
    ...entry,
    spec: {
      ...entry.spec,
      webview: { url: `/plugin-assets/p/${"b".repeat(32)}/index.html` },
    },
  };
  const hash = await hashPluginViewContent(pluginViewContent(entry.spec));
  expect(await hashPluginViewContent(pluginViewContent(changed.spec))).not.toBe(
    hash,
  );
  const { result, rerender } = renderHook(
    ({ entry }) => usePluginViewConsent([entry]),
    { initialProps: { entry } },
  );
  await waitFor(() => expect(result.current.ready(entry)).toBe(true));
  await act(() => result.current.grant(entry));
  expect(result.current.isAllowed(entry)).toBe(true);
  rerender({ entry: changed });
  expect(result.current.isAllowed(changed)).toBe(false);
  await waitFor(() => expect(result.current.ready(changed)).toBe(true));
  expect(result.current.isAllowed(changed)).toBe(false);
});

it("ignores a stale digest promise and an old view while current content is being authorized", async () => {
  let resolveOld!: (value: ArrayBuffer) => void;
  let resolveNew!: (value: ArrayBuffer) => void;
  const oldHash = new Promise<ArrayBuffer>((resolve) => {
    resolveOld = resolve;
  });
  const newHash = new Promise<ArrayBuffer>((resolve) => {
    resolveNew = resolve;
  });
  const digest = vi
    .spyOn(webcrypto.subtle, "digest")
    .mockReturnValueOnce(oldHash)
    .mockReturnValueOnce(newHash);
  try {
    const changed = {
      ...pageViewEntry,
      spec: {
        ...pageViewEntry.spec,
        webview: { url: `/plugin-assets/p/${"b".repeat(32)}/index.html` },
      },
    };
    const { result, rerender } = renderHook(
      ({ entry }) => usePluginViewConsent([entry]),
      { initialProps: { entry: pageViewEntry } },
    );
    rerender({ entry: changed });
    await act(async () => {
      await result.current.grant(pageViewEntry);
    });
    expect(result.current.isAllowed(changed)).toBe(false);
    expect(result.current.isAllowed(pageViewEntry)).toBe(false);
    await act(async () => {
      resolveNew(new Uint8Array(32).fill(2).buffer);
    });
    await waitFor(() => expect(result.current.ready(changed)).toBe(true));
    await act(async () => {
      await result.current.grant(changed);
    });
    expect(result.current.isAllowed(changed)).toBe(true);
    await act(async () => {
      resolveOld(new Uint8Array(32).fill(1).buffer);
    });
    expect(result.current.isAllowed(changed)).toBe(true);
    expect(result.current.isAllowed(pageViewEntry)).toBe(false);
    await act(async () => {
      await result.current.revoke(changed);
    });
    expect(result.current.isAllowed(changed)).toBe(false);
  } finally {
    digest.mockRestore();
  }
});

it.each([viewEntry, pageViewEntry])(
  "closes connected readers across deferred content hashing and session replacement ($spec.webview)",
  async (entry) => {
    function feed(text: string) {
      const listeners = new Set<() => void>();
      let value = { seq: 1, text };
      return {
        stream: {
          read: () => value,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        } satisfies StreamFeed,
        append(tail: string) {
          value = { ...value, text: value.text + tail };
          for (const listener of listeners) listener();
        },
      };
    }
    const feeds = new Map([
      ["a", feed("Session A")],
      ["b", feed("Session B")],
      ["c", feed("Session C")],
    ]);
    mocks.sessionBridge.mockImplementation((sessionId: string) => ({
      projection: {
        ...projection,
        messages: [
          { seq: 1, role: "assistant", text: `Public story ${sessionId}` },
        ],
      },
      stream: feeds.get(sessionId)!.stream,
    }));
    function Host({
      current,
      sessionId,
    }: {
      current: PluginViewEntry;
      sessionId: string;
    }) {
      const consent = usePluginViewConsent([current]);
      return (
        <>
          <button
            disabled={!consent.ready(current)}
            onClick={() => void consent.grant(current)}
          >
            Allow current
          </button>
          <PluginViewHost
            entry={current}
            sessionId={sessionId}
            sessionBridgeAllowed={consent.isAllowed(current)}
            onFallback={() => {}}
          />
        </>
      );
    }
    const view = render(<Host current={entry} sessionId="a" />);
    const allow = () =>
      screen.getByRole<HTMLButtonElement>("button", { name: "Allow current" });
    await waitFor(() => expect(allow().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(allow());
    });
    await waitFor(() =>
      expect(screen.getByTitle("Consented page")).toBeTruthy(),
    );
    const oldFrame = screen.getByTitle("Consented page");
    fireEvent.load(oldFrame);
    const first = mocks.connections[0]!;
    expect(JSON.stringify(first.states)).toContain("Public story a");
    act(() => feeds.get("a")!.append(" allowed tail"));
    await waitFor(() =>
      expect(first.streams).toContainEqual({ seq: 1, append: " allowed tail" }),
    );

    const deferredDigest = () => {
      let resolve!: (value: ArrayBuffer) => void;
      const promise = new Promise<ArrayBuffer>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const pending = deferredDigest();
    const latest = deferredDigest();
    const digest = vi
      .spyOn(webcrypto.subtle, "digest")
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(latest.promise);
    try {
      const changed = {
        ...entry,
        spec: { ...entry.spec, description: "Content replaced while hashing" },
      };
      const current = {
        ...entry,
        spec: {
          ...entry.spec,
          webview: entry.spec.webview?.url
            ? { url: `/plugin-assets/p/${"b".repeat(32)}/index.html` }
            : { html: "<p>Current reader</p>" },
        },
      };
      view.rerender(<Host current={changed} sessionId="a" />);
      expect(first.close).toHaveBeenCalledOnce();
      expect(screen.queryByTitle("Consented page")).toBeNull();
      expect(allow().disabled).toBe(true);
      const oldDeliveries = {
        states: [...first.states],
        streams: [...first.streams],
      };
      act(() => feeds.get("a")!.append(" withheld old tail"));
      view.rerender(<Host current={current} sessionId="b" />);
      act(() => feeds.get("b")!.append(" withheld current tail"));
      fireEvent.load(oldFrame);
      await act(async () => {
        pending.resolve(new Uint8Array(32).fill(1).buffer);
      });
      expect(allow().disabled).toBe(true);
      expect(screen.queryByTitle("Consented page")).toBeNull();
      expect(mocks.connections).toHaveLength(1);
      await act(async () => {
        latest.resolve(new Uint8Array(32).fill(2).buffer);
      });
      expect(allow().disabled).toBe(false);
      expect(screen.queryByTitle("Consented page")).toBeNull();
      expect(first.states).toEqual(oldDeliveries.states);
      expect(first.streams).toEqual(oldDeliveries.streams);

      await act(async () => {
        fireEvent.click(allow());
      });
      await waitFor(() =>
        expect(screen.getByTitle("Consented page")).toBeTruthy(),
      );
      const currentFrame = screen.getByTitle("Consented page");
      expect(currentFrame).not.toBe(oldFrame);
      fireEvent.load(currentFrame);
      const second = mocks.connections[1]!;
      expect(JSON.stringify(second.states)).toContain("Public story b");
      expect(JSON.stringify(second.states)).toContain("withheld current tail");
      act(() => feeds.get("b")!.append(" allowed current tail"));
      await waitFor(() =>
        expect(second.streams).toContainEqual({
          seq: 1,
          append: " allowed current tail",
        }),
      );

      const currentDeliveries = {
        states: [...second.states],
        streams: [...second.streams],
      };
      view.rerender(<Host current={current} sessionId="c" />);
      expect(second.close).toHaveBeenCalledOnce();
      const nextFrame = screen.getByTitle("Consented page");
      expect(nextFrame).not.toBe(currentFrame);
      act(() => feeds.get("b")!.append(" stale session tail"));
      fireEvent.load(currentFrame);
      expect(second.states).toEqual(currentDeliveries.states);
      expect(second.streams).toEqual(currentDeliveries.streams);
      fireEvent.load(nextFrame);
      expect(mocks.connections).toHaveLength(3);
      expect(JSON.stringify(mocks.connections[2]!.states)).toContain(
        "Public story c",
      );
      expect(JSON.stringify(first.states)).not.toContain("Public story b");
      expect(JSON.stringify(second.states)).not.toContain("Public story c");
    } finally {
      digest.mockRestore();
    }
  },
);
