import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MaxOutputTokensCard } from "../llm-max-output-tokens.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("max output token draft", () => {
  it("previews model clamping and input reserve using the shared budget", () => {
    const view = render(
      <MaxOutputTokensCard
        override={32768}
        modelLimit={8192}
        contextWindow={65536}
        onChange={vi.fn()}
      />,
    );
    const cell = (label: string) =>
      within(screen.getByText(label).parentElement!);
    expect(cell("Effective output budget").getByText("8,192")).toBeTruthy();
    expect(cell("Remaining input budget").getByText("57,344")).toBeTruthy();
    view.rerender(
      <MaxOutputTokensCard
        override={8192}
        contextWindow={8192}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "leave room for input",
    );
  });

  it("uses the preset default when the UI override is cleared", () => {
    const view = render(
      <MaxOutputTokensCard
        override={undefined}
        defaultValue={4096}
        contextWindow={32768}
        onChange={vi.fn()}
      />,
    );
    const cell = () =>
      within(screen.getByText("Effective output budget").parentElement!);
    expect(cell().getByText("4,096")).toBeTruthy();
    view.rerender(
      <MaxOutputTokensCard
        override={8192}
        defaultValue={4096}
        contextWindow={32768}
        onChange={vi.fn()}
      />,
    );
    expect(cell().getByText("8,192")).toBeTruthy();
  });

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
