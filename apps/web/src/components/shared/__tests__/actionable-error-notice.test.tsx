import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ActionableErrorNotice } from "../actionable-error-notice.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps panel errors readable without a badge and copies their original detail", async () => {
  await i18n.changeLanguage("en-US");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ActionableErrorNotice error="401 Unauthorized" layout="panel" />);
  expect(screen.queryByText(i18n.t("error.actionable.badge.auth"))).toBeNull();
  const message = screen.getByText(i18n.t("error.actionable.auth"));
  expect(message.classList.contains("text-xs")).toBe(true);
  expect(message.classList.contains("text-foreground")).toBe(true);
  const disclosure = screen.getByRole("button", { name: "Show details" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(disclosure);
  const detail = document.getElementById(
    disclosure.getAttribute("aria-controls")!,
  );
  expect(detail?.classList.contains("text-muted-foreground")).toBe(true);
  expect(detail?.classList.contains("font-mono")).toBe(true);
  expect(screen.getByText("401 Unauthorized")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledExactlyOnceWith("401 Unauthorized"),
  );
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expect(screen.queryByText("401 Unauthorized")).toBeNull();
});
