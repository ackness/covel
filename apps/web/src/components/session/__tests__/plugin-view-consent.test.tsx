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
import type { PluginViewEntry } from "../game-view/use-plugin-views.js";
import { useGameViewMode } from "../game-view/use-game-view-mode.js";
import { PluginViewHost } from "../plugin-view-host.js";
import { PluginWebview } from "../plugin-webview.js";
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
    close: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => mocks.store,
}));
vi.mock("../use-session-bridge-actions.js", () => ({
  useSessionBridgeActions: (_entry: PluginViewEntry, sessionId: string) => ({
    ...mocks.sessionBridge(sessionId),
    handlers: {},
    isCurrent: () => true,
    retire: () => {},
  }),
}));
vi.mock("../plugin-panel.js", () => ({
  PluginPanel: ({
    spec,
    sessionBridge,
  }: {
    spec: typeof viewEntry.spec;
    sessionBridge?: { projection: typeof projection };
  }) => (
    <PluginWebview
      title="Consented page"
      html={spec.webview?.html}
      src={spec.webview?.url}
      locked={false}
      handlers={{}}
      state={sessionBridge ? { session: sessionBridge.projection } : {}}
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
      close: vi.fn(),
    };
    mocks.connections.push(connection);
    return {
      pushState: (value: unknown) => {
        mocks.posted.push(value);
        connection.states.push(value);
      },
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

it("requires every declared capability independently and survives remount with the same content", async () => {
  const entry = {
    ...viewEntry,
    spec: {
      ...viewEntry.spec,
      capabilities: ["submitAction", "abortExecution"] as const,
    },
  };
  const hash = await hashPluginViewContent(pluginViewContent(entry.spec));
  await mocks.store!.set(sessionViewConsentKey("p", hash), true);
  const first = renderHook(() => usePluginViewConsent([entry]));
  await waitFor(() => expect(first.result.current.ready(entry)).toBe(true));
  expect(first.result.current.isAllowed(entry)).toBe(false);
  await mocks.store!.set(
    sessionViewConsentKey("p", hash, "submitAction"),
    true,
  );
  expect(first.result.current.isAllowed(entry)).toBe(false);
  await act(() => first.result.current.grant(entry));
  expect(first.result.current.isAllowed(entry)).toBe(true);
  first.unmount();
  const next = renderHook(() => usePluginViewConsent([entry]));
  await waitFor(() => expect(next.result.current.isAllowed(entry)).toBe(true));
  await act(() => next.result.current.revoke(entry, "abortExecution"));
  expect(next.result.current.isAllowed(entry)).toBe(false);
  expect(
    mocks.store!.get(sessionViewConsentKey("p", hash, "submitAction")),
  ).toBe(true);
});

it.each(["success", "failure", "navigation", "revoke"] as const)(
  "does not authorize optimistic persistence before %s settles",
  async (outcome) => {
    let finish!: () => void;
    let fail!: (reason: Error) => void;
    let saving = false;
    const store = new SettingsStore({
      load: async () => ({}),
      save: () =>
        saving
          ? new Promise<void>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            })
          : Promise.resolve(),
      loadSecrets: async () => ({}),
      saveSecrets: async () => {},
    });
    await store.init();
    mocks.store = store;
    const entry = {
      ...viewEntry,
      spec: { ...viewEntry.spec, capabilities: ["submitAction"] as const },
    };
    const hook = renderHook(
      ({ scope }) => usePluginViewConsent([entry], scope),
      { initialProps: { scope: "visit-one" } },
    );
    await waitFor(() => expect(hook.result.current.ready(entry)).toBe(true));
    saving = true;
    let grant!: Promise<void>;
    act(() => {
      grant = hook.result.current.grant(entry).catch(() => {});
    });
    await waitFor(() => expect(finish).toBeDefined());
    expect(hook.result.current.isAllowed(entry)).toBe(false);
    if (outcome === "navigation") hook.rerender({ scope: "visit-two" });
    let revoke: Promise<void> | undefined;
    if (outcome === "revoke") {
      saving = false;
      act(() => {
        revoke = hook.result.current.revoke(entry);
      });
    }
    saving = false;
    await act(async () => {
      if (outcome === "failure") {
        fail(new Error("save refused"));
      } else {
        finish();
      }
      await grant;
      await revoke;
    });
    expect(hook.result.current.isAllowed(entry)).toBe(outcome === "success");
  },
);

it("observes external SettingsStore refresh and fails closed on revocation", async () => {
  let bundle = {
    schemaVersion: 2 as const,
    revision: 0,
    savedAt: "",
    entries: {} as Record<string, unknown>,
  };
  const store = new SettingsStore({
    load: async () => bundle.entries,
    save: async () => {},
    loadSecrets: async () => ({}),
    saveSecrets: async () => {},
    loadWithRevision: async () => structuredClone(bundle),
    saveWithRevision: async (entries, revision) => {
      bundle = { ...bundle, entries, revision: revision + 1 };
      return structuredClone(bundle);
    },
  });
  await store.init();
  mocks.store = store;
  const hook = renderHook(() => usePluginViewConsent([viewEntry]));
  await waitFor(() => expect(hook.result.current.ready(viewEntry)).toBe(true));
  await act(() => hook.result.current.grant(viewEntry));
  const guard = hook.result.current.isCurrent(viewEntry);
  expect(guard()).toBe(true);
  bundle = { ...bundle, revision: bundle.revision + 1, entries: {} };
  await act(() => store.refresh());
  expect(guard()).toBe(false);
  expect(hook.result.current.isAllowed(viewEntry)).toBe(false);
});

it("binds consent to the surface and keeps independently granted pages separate", async () => {
  const main = {
    ...viewEntry,
    spec: { ...viewEntry.spec, surface: "main" as const },
  };
  const composer = {
    ...viewEntry,
    mode: "plugin:p:input" as const,
    viewId: "input",
    spec: {
      ...viewEntry.spec,
      id: "input",
      surface: "composer" as const,
      capabilities: ["submitAction" as const],
    },
  };
  const { result, rerender } = renderHook(
    ({ entries }) => usePluginViewConsent(entries, "visit"),
    {
      initialProps: { entries: [main, composer] as readonly PluginViewEntry[] },
    },
  );
  await waitFor(() => expect(result.current.ready(composer)).toBe(true));
  await act(() => result.current.grant(main));
  expect(result.current.isAllowed(main)).toBe(true);
  expect(result.current.isAllowed(composer)).toBe(false);
  await act(() => result.current.grant(composer));
  await act(() => result.current.revoke(composer, "submitAction"));
  expect(result.current.isAllowed(main)).toBe(true);
  expect(result.current.isAllowed(composer)).toBe(false);
  const changed = {
    ...main,
    spec: { ...main.spec, surface: "composer" as const },
  };
  rerender({ entries: [changed, composer] });
  expect(result.current.isAllowed(changed)).toBe(false);
  await waitFor(() => expect(result.current.ready(changed)).toBe(true));
  expect(result.current.isAllowed(changed)).toBe(false);
});
it("does not resolve a composer declaration as a world default main view", () => {
  const entry = {
    ...viewEntry,
    spec: { ...viewEntry.spec, surface: "composer" as const },
  };
  const { result } = renderHook(() =>
    useGameViewMode(
      { metadata: { defaultViewMode: entry.mode } },
      { views: [entry], reload: () => {}, status: "ready" },
      () => true,
    ),
  );
  expect(result.current[0]).toBe("parsed");
  expect(result.current[2].consentView).toBeUndefined();
});

it("waits for the new visit's world default after dropping a previous selection", () => {
  const { result, rerender } = renderHook(
    ({ scope, world }) =>
      useGameViewMode(
        world,
        { views: [], reload() {}, status: "ready" },
        undefined,
        scope,
      ),
    {
      initialProps: {
        scope: "first",
        world: { metadata: { defaultViewMode: "stage" } } as {
          metadata: { defaultViewMode: string };
        } | null,
      },
    },
  );
  expect(result.current[0]).toBe("stage");
  rerender({ scope: "second", world: null });
  expect(result.current[0]).toBe("parsed");
  rerender({
    scope: "second",
    world: { metadata: { defaultViewMode: "stage" } },
  });
  expect(result.current[0]).toBe("stage");
});

it.each([viewEntry, pageViewEntry])(
  "closes connected readers across deferred content hashing and session replacement ($spec.webview)",
  async (entry) => {
    const stories = new Map([
      ["a", "Public story a"],
      ["b", "Public story b"],
      ["c", "Public story c"],
    ]);
    mocks.sessionBridge.mockImplementation((sessionId: string) => ({
      projection: {
        ...projection,
        messages: [
          { seq: 1, role: "assistant", text: stories.get(sessionId)! },
        ],
      },
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
    stories.set("a", "Public story a updated");
    view.rerender(<Host current={entry} sessionId="a" />);
    expect(JSON.stringify(first.states)).toContain("Public story a updated");

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
      };
      stories.set("a", "Public story a withheld old tail");
      view.rerender(<Host current={current} sessionId="b" />);
      stories.set("b", "Public story b withheld current tail");
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
      stories.set("b", "Public story b updated");
      view.rerender(<Host current={current} sessionId="b" />);
      expect(JSON.stringify(second.states)).toContain("Public story b updated");

      const currentDeliveries = {
        states: [...second.states],
      };
      view.rerender(<Host current={current} sessionId="c" />);
      expect(second.close).toHaveBeenCalledOnce();
      const nextFrame = screen.getByTitle("Consented page");
      expect(nextFrame).not.toBe(currentFrame);
      stories.set("b", "Public story b stale session tail");
      fireEvent.load(currentFrame);
      expect(second.states).toEqual(currentDeliveries.states);
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
