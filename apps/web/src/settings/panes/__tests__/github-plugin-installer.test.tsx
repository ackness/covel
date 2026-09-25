import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GithubPluginInstaller } from "../GithubPluginInstaller.js";
import i18n from "@/i18n";

const preview = {
  id: "example-note",
  version: "1.0.0",
  description: "A note",
  hasServerCode: true,
  source: {
    repository: "https://github.com/example/plugins",
    commit: "a".repeat(40),
    path: "plugins/note",
    digest: "b".repeat(64),
  },
  token: "signed-preview",
  expiresAt: Date.now() + 900_000,
};
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("requires consent, resets consent when the package changes and installs only the selected preview", async () => {
  const installed = vi.fn();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview"))
      return Response.json({
        items: [
          preview,
          {
            ...preview,
            id: "second-note",
            token: "second-preview",
            source: { ...preview.source, path: "plugins/second" },
          },
        ],
      });
    expect(JSON.parse(String(init?.body))).toEqual({
      token: "second-preview",
      acceptRisk: true,
    });
    return Response.json({
      ok: true,
      kind: "plugin",
      id: "second-note",
      restartRequired: true,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <GithubPluginInstaller
      onInstalled={installed}
      onBusyChange={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: preview.source.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview plugin" }));
  const button = await screen.findByRole("button", {
    name: "Confirm installation",
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/without a process sandbox/)).toBeTruthy();
  const checkbox = screen.getByRole("checkbox");
  fireEvent.click(checkbox);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(checkbox);
  fireEvent.click(button);
  await waitFor(() =>
    expect(installed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "second-note" }),
      expect.objectContaining({ token: "second-preview" }),
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Confirm installation" }),
  ).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("invalidates the preview when the URL changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [preview] })),
  );
  render(
    <GithubPluginInstaller
      onInstalled={() => undefined}
      onBusyChange={() => undefined}
    />,
  );
  const input = screen.getByLabelText("GitHub URL");
  fireEvent.change(input, { target: { value: preview.source.repository } });
  fireEvent.click(screen.getByRole("button", { name: "Preview plugin" }));
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(input, {
    target: { value: "https://github.com/another/plugin" },
  });
  expect(
    screen.queryByRole("button", { name: "Confirm installation" }),
  ).toBeNull();
});

it("cancels inspection without presenting a stale result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        ),
    ),
  );
  render(
    <GithubPluginInstaller
      onInstalled={() => undefined}
      onBusyChange={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: preview.source.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview plugin" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Confirm installation" }),
  ).toBeNull();
});
