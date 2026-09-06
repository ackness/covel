import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenControl } from "../TokenControl.js";
import type { ThemeScheme } from "@/theme-system/types.js";
import type { TokenSpec } from "@/theme-system/token-schema.js";

vi.mock("@/theme-system/color.js", () => ({
  toSwatchHex: (value: string) => value,
  isValidCssColor: () => true,
}));

const spec: TokenSpec = {
  name: "--story-color",
  label: "Story colour",
  control: "color",
  perScheme: true,
};

describe("appearance control pending edits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.removeAttribute("style");
  });

  it("flushes the old scheme even when both schemes have the same default", () => {
    const saved: Partial<Record<ThemeScheme, string>> = {};
    const control = (scheme: ThemeScheme) => (
      <TokenControl
        spec={spec}
        scheme={scheme}
        themeDefault="#eeeeee"
        override={null}
        onCommit={(value) => {
          saved[scheme] = value;
        }}
        onReset={() => undefined}
      />
    );
    const view = render(control("dark"));
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "#f4ead8" },
    });
    expect(saved).toEqual({});
    view.rerender(control("light"));
    expect(saved).toEqual({ dark: "#f4ead8" });
    expect((view.getByRole("textbox") as HTMLInputElement).value).toBe(
      "#eeeeee",
    );
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "#292018" },
    });
    act(() => vi.advanceTimersByTime(200));
    expect(saved).toEqual({ dark: "#f4ead8", light: "#292018" });
  });

  it("debounces edits and saves the final value before focus leaves", () => {
    const commit = vi.fn();
    const view = render(
      <TokenControl
        spec={spec}
        scheme="dark"
        themeDefault="#eeeeee"
        override={null}
        onCommit={commit}
        onReset={() => undefined}
      />,
    );
    const input = view.getByRole("textbox");
    fireEvent.change(input, { target: { value: "#f4ead8" } });
    fireEvent.change(input, { target: { value: "#ffeed0" } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledExactlyOnceWith("#ffeed0");
    act(() => vi.advanceTimersByTime(200));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("saves a pending edit when the settings pane closes", () => {
    const commit = vi.fn();
    const view = render(
      <TokenControl
        spec={spec}
        scheme="dark"
        themeDefault="#eeeeee"
        override={null}
        onCommit={commit}
        onReset={() => undefined}
      />,
    );
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "#f4ead8" },
    });
    view.unmount();
    expect(commit).toHaveBeenCalledExactlyOnceWith("#f4ead8");
  });

  it("cancels a pending preset when the player immediately follows the theme", () => {
    const commit = vi.fn();
    const reset = vi.fn();
    const view = render(
      <TokenControl
        spec={{
          name: "--story-font-family",
          label: "Body typeface",
          control: "font",
          options: [{ value: "monospace", label: "Monospace" }],
        }}
        scheme="dark"
        themeDefault="serif"
        override={null}
        onCommit={commit}
        onReset={reset}
      />,
    );
    const select = view.getByRole("combobox");
    fireEvent.change(select, { target: { value: "monospace" } });
    fireEvent.change(select, { target: { value: "" } });
    act(() => vi.advanceTimersByTime(200));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(
      document.documentElement.style.getPropertyValue("--story-font-family"),
    ).toBe("");
    expect((view.getByRole("textbox") as HTMLInputElement).value).toBe("serif");
  });
});
