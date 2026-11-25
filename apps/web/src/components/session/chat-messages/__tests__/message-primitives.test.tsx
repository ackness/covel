import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { RawJsonBlock } from "../message-primitives.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("RawJsonBlock", () => {
  it("handles rejected clipboard writes without setting copied state", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")),
      },
    });

    render(<RawJsonBlock content='{"ok":true}' />);
    const copyBtn = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyBtn.querySelector(".text-green-500")).toBeNull();
  });
});
