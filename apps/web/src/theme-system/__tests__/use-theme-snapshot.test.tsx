import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useThemeSnapshot } from "../use-theme-snapshot.js";

const root = document.documentElement;

afterEach(() => {
  cleanup();
  root.removeAttribute("data-theme");
  root.removeAttribute("data-scheme");
  root.removeAttribute("style");
});

it("reads the active theme and follows a change of scheme", async () => {
  root.setAttribute("data-theme", "book");
  root.setAttribute("data-scheme", "light");
  root.style.setProperty("--accent-primary", "rgb(10 20 30)");
  root.style.setProperty("--font-sans", "Inter, sans-serif");
  const { result } = renderHook(() => useThemeSnapshot());
  await waitFor(() => expect(result.current.id).toBe("book"));
  expect(result.current.scheme).toBe("light");
  expect(result.current.tokens.accent).toBe("rgb(10 20 30)");
  expect(result.current.tokens.fontSans).toBe("Inter, sans-serif");
  // Every token is present, as a string, even when the theme leaves it unset.
  expect(
    Object.values(result.current.tokens).every(
      (value) => typeof value === "string",
    ),
  ).toBe(true);

  const before = result.current;
  await act(async () => {
    root.setAttribute("data-scheme", "dark");
    root.style.setProperty("--accent-primary", "rgb(200 210 220)");
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.scheme).toBe("dark"));
  expect(result.current.tokens.accent).toBe("rgb(200 210 220)");
  expect(result.current).not.toBe(before);
});
