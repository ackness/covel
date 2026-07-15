import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  clearOperatorToken,
  getOperatorToken,
  storeOperatorToken,
} from "@/services/session-credentials.js";
import { OperatorAccessPane } from "../OperatorAccessPane.js";

const localStorageMock = (() => {
  let values: Record<string, string> = {};
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
    removeItem: (key: string) => {
      delete values[key];
    },
    clear: () => {
      values = {};
    },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

describe("OperatorAccessPane", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => {
    cleanup();
    clearOperatorToken();
  });

  it("stores a trimmed token and reloads hosted data", () => {
    const reload = vi.fn();
    render(<OperatorAccessPane onCredentialChange={reload} />);

    const input = screen.getByLabelText("Operator token");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "  operator-secret  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save and reload" }));

    expect(getOperatorToken()).toBe("operator-secret");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("loads and clears an existing token before reloading", () => {
    storeOperatorToken("existing-secret");
    const reload = vi.fn();
    render(<OperatorAccessPane onCredentialChange={reload} />);

    expect(screen.getByDisplayValue("existing-secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear and reload" }));

    expect(getOperatorToken()).toBeUndefined();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps save disabled until a non-whitespace token is entered", () => {
    render(<OperatorAccessPane onCredentialChange={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save and reload" });

    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Operator token"), {
      target: { value: "   " },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });
});
