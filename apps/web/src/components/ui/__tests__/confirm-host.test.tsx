import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { requestChoices } from "@/lib/confirm-channel.js";
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
