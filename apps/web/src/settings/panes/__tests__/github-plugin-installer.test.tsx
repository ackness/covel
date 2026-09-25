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
    tracking: { kind: "default-branch" },
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

it("installs selected packages successively without previewing again and requires consent for each", async () => {
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
    const next =
      installed.mock.calls.length === 0 ? "second-preview" : "signed-preview";
    expect(JSON.parse(String(init?.body))).toEqual({
      token: next,
      acceptRisk: true,
    });
    return Response.json({
      ok: true,
      kind: "plugin",
      id: next === "second-preview" ? "second-note" : "example-note",
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
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("example-note · 1.0.0")).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(button);
  await waitFor(() => expect(installed).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("button", { name: "Confirm installation" }),
  ).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
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

it("retains remaining packages after a failed installation and clears the error on selection", async () => {
  const installed = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/preview")
        ? Response.json({
            items: [
              preview,
              {
                ...preview,
                id: "other-note",
                token: "other-token",
                source: { ...preview.source, path: "examples/other" },
              },
            ],
          })
        : Response.json({ error: "Already installed" }, { status: 409 }),
    ),
  );
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
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(installed).not.toHaveBeenCalled();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Confirm installation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
