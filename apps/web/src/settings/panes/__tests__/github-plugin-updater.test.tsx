import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  GithubPluginUpdatePreview,
  PluginInstallation,
} from "@covel/shared";
import { GithubPackageUpdater } from "../GithubPackageUpdater.js";
import i18n from "@/i18n";
const source = {
  repository: "https://github.com/example/plugins",
  commit: "a".repeat(40),
  path: "plugins/note",
  digest: "b".repeat(64),
  tracking: { kind: "default-branch" as const },
};
const installation: PluginInstallation = {
  id: "example-note",
  version: "1.0.0",
  source,
  pendingUpdate: null,
};
const preview: GithubPluginUpdatePreview = {
  id: installation.id,
  version: "1.1.0",
  description: "Updated note",
  hasServerCode: true,
  source: { ...source, commit: "c".repeat(40), digest: "d".repeat(64) },
  previous: { version: installation.version, source },
  token: "update-preview",
  expiresAt: Date.now() + 900_000,
  changes: {
    added: ["new.txt"],
    modified: ["server.js"],
    removed: ["old.txt"],
  },
};
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(current = installation, updated = vi.fn(), cancelled = vi.fn()) {
  return render(
    <GithubPackageUpdater
      installation={current}
      disabled={false}
      onBusyChange={() => undefined}
      onUpdated={updated}
      onCancelled={cancelled}
    />,
  );
}
it("shows exact version and file changes, requires fresh consent after URL edits, then stages the approved token", async () => {
  const updated = vi.fn();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview"))
      return Response.json({ status: "available", preview });
    expect(JSON.parse(String(init?.body))).toEqual({
      token: preview.token,
      acceptRisk: true,
    });
    return Response.json({
      ok: true,
      kind: "plugin",
      id: installation.id,
      restartRequired: true,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  mount(installation, updated);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  const confirm = await screen.findByRole("button", { name: "Confirm update" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("1.0.0 → 1.1.0")).toBeTruthy();
  expect(screen.getByText("~ server.js")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    `${source.repository}/compare/${source.commit}...${preview.source.commit}`,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText(/Package version URL/), {
    target: { value: `${source.repository}/tree/v2/plugins/note` },
  });
  expect(screen.queryByRole("button", { name: "Confirm update" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  const nextConfirm = await screen.findByRole("button", {
    name: "Confirm update",
  });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(nextConfirm);
  await waitFor(() =>
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ restartRequired: true }),
    ),
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it.each(["current", "pinned"] as const)(
  "shows %s without offering replacement",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status })),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm update" })).toBeNull();
  },
);
it("allows cancelling a pending update and exposes startup failure without claiming it was applied", async () => {
  const cancelled = vi.fn();
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe("DELETE");
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  mount(
    {
      ...installation,
      pendingUpdate: {
        version: preview.version,
        source: preview.source,
        error: "Local edits blocked replacement",
      },
    },
    vi.fn(),
    cancelled,
  );
  expect(screen.getByRole("alert").textContent).toContain("Local edits");
  expect(
    screen.queryByRole("button", { name: "Check for updates" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel pending update" }),
  );
  await waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});
it("reports a check failure without leaving a stale update preview", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "available", preview }))
      .mockResolvedValueOnce(
        Response.json({ error: "Local changes detected" }, { status: 409 }),
      ),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByRole("button", { name: "Confirm update" });
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm update" })).toBeNull();
});
