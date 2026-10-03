import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GithubCollectionPreview } from "@covel/shared";
import { GithubCollectionInstaller } from "../GithubCollectionInstaller.js";
import i18n from "@/i18n";

const source = {
  repository: "https://github.com/example/pack",
  commit: "a".repeat(40),
  path: "plugins/barrow-dice",
  digest: "b".repeat(64),
  tracking: { kind: "default-branch" as const },
};
const plugin = {
  kind: "plugin" as const,
  id: "barrow-dice",
  version: "1.0.0",
  description: "Dice for the barrow",
  hasServerCode: true,
  source,
  token: "plugin-token",
  expiresAt: Date.now() + 900_000,
};
const world = {
  ...plugin,
  kind: "world" as const,
  id: "barrow",
  description: "A tabletop world",
  hasServerCode: false,
  source: { ...source, path: "worlds/barrow" },
  token: "world-token",
};
const pack: GithubCollectionPreview = {
  collection: { id: "barrow-pack", name: "Barrow Pack", version: "1.2.0" },
  items: [plugin, world],
  problems: [],
};

const consent = () =>
  screen.getByLabelText(
    "I understand the risks and trust this source.",
  ) as HTMLInputElement;
const packageBox = (id: string) =>
  screen.getByRole("checkbox", { name: new RegExp(id) }) as HTMLInputElement;
const installButton = (count: number) =>
  screen.getByRole("button", {
    name: `Install ${count} selected`,
  }) as HTMLButtonElement;

async function previewWith(result: GithubCollectionPreview) {
  const batches: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/install/github/preview") return Response.json(result);
      expect(url).toBe("/api/install/github/batch");
      const body = JSON.parse(String(init?.body));
      expect(body.acceptRisk).toBe(true);
      batches.push(body.tokens);
      return Response.json(
        {
          ok: true,
          installed: result.items
            .filter((item) => body.tokens.includes(item.token))
            .map(({ kind, id }) => ({ kind, id })),
          restartRequired: true,
        },
        { status: 201 },
      );
    }),
  );
  const installed = vi.fn();
  render(
    <GithubCollectionInstaller
      onInstalled={installed}
      onBusyChange={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: source.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("Collection: Barrow Pack · 1.2.0");
  return { installed, batches };
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("installs a plugin and a world together after one consent", async () => {
  const { installed, batches } = await previewWith(pack);

  expect(packageBox("barrow-dice").checked).toBe(true);
  expect(packageBox("Dice for the barrow")).toBe(packageBox("barrow-dice"));
  expect(installButton(2).disabled).toBe(true);
  // A mixed selection states both the code risk and the world notice.
  expect(screen.getByText(/without a process sandbox/)).toBeTruthy();
  expect(
    screen.getByText(/Installing does not authorize plugins/),
  ).toBeTruthy();

  fireEvent.click(consent());
  fireEvent.click(installButton(2));

  await waitFor(() =>
    expect(installed).toHaveBeenCalledWith(
      expect.objectContaining({
        installed: [
          { kind: "plugin", id: "barrow-dice" },
          { kind: "world", id: "barrow" },
        ],
      }),
    ),
  );
  expect(batches).toEqual([["plugin-token", "world-token"]]);
  expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
});

it("asks for consent again when the selection changes and installs only what stays ticked", async () => {
  const { installed, batches } = await previewWith(pack);

  fireEvent.click(consent());
  fireEvent.click(packageBox("Dice for the barrow"));
  expect(consent().checked).toBe(false);
  expect(installButton(1).disabled).toBe(true);

  fireEvent.click(consent());
  fireEvent.click(installButton(1));

  await waitFor(() => expect(installed).toHaveBeenCalledTimes(1));
  expect(batches).toEqual([["world-token"]]);
  // The package left out stays in the list for a later install.
  expect(packageBox("Dice for the barrow").checked).toBe(false);
});

it("blocks a selection that contains a package with an error until it is unticked", async () => {
  await previewWith({
    ...pack,
    problems: [
      {
        level: "error",
        packageId: "barrow",
        message: "World barrow requires action-check@2.",
      },
    ],
  });

  fireEvent.click(consent());
  expect(
    screen.getByText("World barrow requires action-check@2."),
  ).toBeTruthy();
  expect(installButton(2).disabled).toBe(true);

  fireEvent.click(packageBox("A tabletop world"));
  fireEvent.click(consent());
  expect(installButton(1).disabled).toBe(false);
});

it("drops the preview when the URL changes", async () => {
  await previewWith(pack);

  fireEvent.change(screen.getByLabelText("GitHub URL"), {
    target: { value: "https://github.com/another/pack" },
  });

  expect(screen.queryByText("Collection: Barrow Pack · 1.2.0")).toBeNull();
  expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
});
