import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MaxOutputTokensCard } from "../llm-max-output-tokens.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("max output token draft", () => {
  it("saves only whole positive values within a known limit", () => {
    const onChange = vi.fn();
    render(
      <MaxOutputTokensCard
        override={undefined}
        modelLimit={4096}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "Max Output Tokens" });
    for (const value of ["0", "-1", "1.5", "5000"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "2048" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(2048);
  });

  it("leaves unknown limits unset and preserves a dirty draft on external changes", () => {
    const onChange = vi.fn();
    const view = render(
      <MaxOutputTokensCard override={1024} onChange={onChange} />,
    );
    const input = screen.getByRole("spinbutton", { name: "Max Output Tokens" });
    expect(input.hasAttribute("max")).toBe(false);
    expect(screen.getByText("Model limits unknown")).toBeTruthy();
    fireEvent.change(input, { target: { value: "2048" } });
    view.rerender(<MaxOutputTokensCard override={4096} onChange={onChange} />);
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("2048");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved value" }));
    expect((input as HTMLInputElement).value).toBe("4096");
  });
});
