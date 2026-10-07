import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { requestChoices, requestConfirm } from "@/lib/confirm-channel.js";
import { ConfirmHost } from "../confirm-host.js";

const REQUEST = {
  title: "Authorize community plugins",
  message: "Untick any you do not want to run.",
  confirmLabel: "Authorize selected",
  cancelLabel: "Not now",
  choices: [
    { id: "barrow-dice", label: "Barrow Dice", detail: "barrow-dice · 1.0.0" },
    { id: "barrow-map", label: "Barrow Map" },
  ],
};

afterEach(cleanup);

async function open() {
  render(<ConfirmHost />);
  let answer!: Promise<readonly string[]>;
  await act(async () => {
    answer = requestChoices(REQUEST);
  });
  // Wrapped: returning the bare promise from an async function would wait
  // for the answer the test has yet to give.
  return { answer };
}

it("names every entry, starts with all ticked, and returns the ones left ticked", async () => {
  const { answer } = await open();

  expect(screen.getByText("barrow-dice · 1.0.0")).toBeTruthy();
  const map = screen.getByLabelText("Barrow Map") as HTMLInputElement;
  expect(map.checked).toBe(true);
  fireEvent.click(map);
  fireEvent.click(screen.getByRole("button", { name: "Authorize selected" }));

  await expect(answer).resolves.toEqual(["barrow-dice"]);
});

it("cannot authorize an empty selection, and declining authorizes nothing", async () => {
  const { answer } = await open();

  for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
  expect(
    (
      screen.getByRole("button", {
        name: "Authorize selected",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));

  await expect(answer).resolves.toEqual([]);
});

const DELETE_REQUEST = {
  title: "Delete Session",
  message: "This cannot be undone.",
  subject: "Lantern Barrow · Turn 3",
  confirmLabel: "Delete",
  cancelLabel: "Cancel",
  destructive: true,
};

async function openDelete() {
  render(<ConfirmHost />);
  let answer!: Promise<boolean>;
  await act(async () => {
    answer = requestConfirm(DELETE_REQUEST);
  });
  return { answer };
}

it("names what a request acts on and approves it with Enter", async () => {
  const { answer } = await openDelete();

  expect(screen.getByText("Lantern Barrow · Turn 3")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

  await expect(answer).resolves.toBe(true);
});

it("does not approve on Enter while Cancel has the focus", async () => {
  const { answer } = await openDelete();

  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  // Left alone, so the browser presses the focused button.
  expect(fireEvent.keyDown(cancel, { key: "Enter" })).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(cancel);

  await expect(answer).resolves.toBe(false);
});

it("never approves a prompt with entries to tick on Enter", async () => {
  const { answer } = await open();

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));

  await expect(answer).resolves.toEqual([]);
});
