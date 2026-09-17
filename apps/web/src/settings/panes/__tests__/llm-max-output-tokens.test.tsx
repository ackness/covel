import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MaxOutputTokensCard } from "../llm-max-output-tokens.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("max output token draft", () => {
  it("validates positive integers independently of catalog limits", () => {
    const onChange = vi.fn();
    render(
      <MaxOutputTokensCard
        override={undefined}
        modelLimit={4096}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "Max Output Tokens" });
    for (const value of ["0", "-1", "1.5", "1000001"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "5000" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(5000);
  });

  it("leaves unknown limits unset and preserves a dirty draft on external changes", () => {
    const onChange = vi.fn();
    const view = render(
      <MaxOutputTokensCard override={1024} onChange={onChange} />,
    );
    const input = screen.getByRole("spinbutton", { name: "Max Output Tokens" });
    expect(input.getAttribute("max")).toBe("1000000");
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
