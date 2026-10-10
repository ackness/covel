import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import { SERVER_SETTINGS, TRACE_RETENTION_SETTING_KEY } from "@covel/shared";
import i18n from "@/i18n";
import { createServerSettingsChannel } from "../server-settings-channel.js";
import { registerCoreSettings } from "../registry/core.js";
import { synchronizeSettings } from "../synchronize-settings.js";
import { SettingWidget } from "../widgets/index.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  toast: vi.fn(),
}));
vi.mock("../store.js", () => ({ getSettings: () => mocks.store }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: mocks.toast }));

const KEY = TRACE_RETENTION_SETTING_KEY;
const PATH = "/api/config/server-settings";

function deviceAdapter(): SettingsBackendAdapter & {
  entries: Record<string, unknown>;
} {
  const adapter = {
    entries: {} as Record<string, unknown>,
    load: async () => ({ ...adapter.entries }),
    save: async (next: Record<string, unknown>) => {
      adapter.entries = { ...next };
    },
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  };
  return adapter;
}

type Answer = Response | Promise<Response>;

/** A server whose answers the test scripts, one per request. */
function serverAnswering(...answers: Answer[]) {
  const requests: Array<{ method: string; body?: unknown; auth?: string }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    expect(input).toBe(PATH);
    requests.push({
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("Authorization") ?? undefined,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("no answer scripted");
    return answer;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

function reports(value: string, source: string, settable: boolean): Response {
  return Response.json({ settings: { [KEY]: { value, source, settable } } });
}

async function mount(fetchImpl: typeof fetch) {
  const adapter = deviceAdapter();
  const store = new SettingsStore(adapter, {
    serverSettings: createServerSettingsChannel(fetchImpl),
  });
  registerCoreSettings(store);
  mocks.store = store;
  await store.init();
  const entry = store.listEntries().find((item) => item.key === KEY)!;
  render(<SettingWidget entry={entry} />);
  return { store, adapter };
}

const select = () => screen.getByRole("combobox") as HTMLSelectElement;

describe("a setting the server holds", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    mocks.toast.mockReset();
    localStorage.clear();
  });
  afterEach(() => cleanup());

  it("marks exactly the keys the server accepts, with the server's schema", () => {
    const store = new SettingsStore(deviceAdapter());
    registerCoreSettings(store);
    const scoped = store
      .listEntries()
      .filter((entry) => entry.scope === "server");
    expect(scoped.map((entry) => entry.key).sort()).toEqual(
      SERVER_SETTINGS.map((definition) => definition.key).sort(),
    );
    for (const entry of scoped) {
      const definition = SERVER_SETTINGS.find((item) => item.key === entry.key);
      expect(entry.schema).toBe(definition?.schema);
      expect(entry.default).toBe(definition?.default);
    }
  });

  it("stays locked until the server answers, then offers the choice", async () => {
    let answer!: (response: Response) => void;
    const { fetchImpl } = serverAnswering(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    await mount(fetchImpl);
    expect(select().disabled).toBe(true);
    expect(screen.getByText(/Asking the server/)).toBeTruthy();

    await act(async () => answer(reports("90", "setting", true)));
    await vi.waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe("90");
    expect(screen.getByText(/Saved on the server/)).toBeTruthy();
  });

  it("writes the choice to the server and nothing to this device", async () => {
    const { fetchImpl, requests } = serverAnswering(
      reports("30", "default", true),
      reports("keep", "setting", true),
    );
    const { adapter } = await mount(fetchImpl);
    await vi.waitFor(() => expect(select().disabled).toBe(false));

    fireEvent.change(select(), { target: { value: "keep" } });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      method: "PUT",
      body: { entries: { [KEY]: "keep" } },
    });
    await vi.waitFor(() => expect(select().value).toBe("keep"));
    expect(adapter.entries).toEqual({});
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("shows the operator's value locked, including one the choices do not offer", async () => {
    const { fetchImpl, requests } = serverAnswering(
      reports("14", "env", false),
    );
    await mount(fetchImpl);
    await screen.findByText("This deployment fixes the value.");
    expect(select().disabled).toBe(true);
    expect(select().value).toBe("14");
    expect(select().selectedOptions[0]?.textContent).toBe("14 days");
    expect(screen.queryByText("Use default")).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("shows a hosted server's value locked as the operator's", async () => {
    const { fetchImpl } = serverAnswering(reports("30", "default", false));
    await mount(fetchImpl);
    await screen.findByText("The operator of this server sets this.");
    expect(select().disabled).toBe(true);
  });

  it("reports a refused write and puts the earlier value back", async () => {
    const { fetchImpl } = serverAnswering(
      reports("7", "setting", true),
      Response.json(
        { error: "Server settings are set by the operator of this server" },
        { status: 403 },
      ),
    );
    await mount(fetchImpl);
    await vi.waitFor(() => expect(select().value).toBe("7"));

    fireEvent.change(select(), { target: { value: "90" } });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith(
      "error",
      "Could not save setting",
      "Server settings are set by the operator of this server",
    );
    expect(select().value).toBe("7");
    expect(select().disabled).toBe(false);
  });

  it("stays locked when the server cannot be reached and unlocks after a later focus", async () => {
    const { fetchImpl } = serverAnswering(
      Promise.reject(new TypeError("Failed to fetch")),
      reports("7", "setting", true),
    );
    const { store } = await mount(fetchImpl);
    await screen.findByText(/The server did not answer/);
    expect(select().disabled).toBe(true);
    expect(select().value).toBe("30");

    const stop = synchronizeSettings(store);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe("7");
    stop();
  });
});
