import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StageDialog } from "../StageDialog.js";

afterEach(cleanup);
const baseProps = {
  message: {
    id: "message",
    content: "Mio speaks.\n\nRin answers.\n\nThe wind quiets.",
    segments: [
      { kind: "narration" as const, text: "Mio speaks." },
      { kind: "narration" as const, text: "Rin answers." },
      { kind: "narration" as const, text: "The wind quiets." },
    ],
  },
  autoPlay: false,
  reducedMotion: true,
};
describe("committed stage reader", () => {
  it("exposes all semantic paragraphs once, outside navigation controls", () => {
    render(<StageDialog {...baseProps} />);
    for (const text of ["Mio speaks.", "Rin answers.", "The wind quiets."]) {
      const paragraph = screen.getByText(text);
      expect(paragraph.closest("button")).toBeNull();
      expect(paragraph.closest('[aria-live="off"]')).not.toBeNull();
    }
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一段" }));
    expect(
      document
        .querySelector('[data-stage-paragraph="1"]')
        ?.getAttribute("data-reader-current"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "重新阅读" }));
    expect(
      document
        .querySelector('[data-stage-paragraph="0"]')
        ?.getAttribute("data-reader-current"),
    ).toBe("true");
  });
  it("maps committed speakers without borrowing a speaker for narration", () => {
    render(
      <StageDialog
        {...baseProps}
        message={{
          ...baseProps.message,
          segments: [
            { kind: "dialogue", text: "Mio speaks.", speaker: "Mio" },
            { kind: "dialogue", text: "Rin answers.", speaker: "Rin" },
            { kind: "narration", text: "The wind quiets." },
          ],
        }}
      />,
    );
    expect(
      screen
        .getAllByTestId("stage-dialog-speaker")
        .map((node) => node.textContent),
    ).toEqual(["Mio", "Rin"]);
    fireEvent.click(screen.getByRole("button", { name: "下一段" }));
    expect(screen.getByText("The wind quiets.")).toBeDefined();
  });
  it("renders plain restored content instantly without a speaker map", () => {
    render(<StageDialog {...baseProps} />);
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    expect(document.querySelector('[data-reveal-hidden="true"]')).toBeNull();
  });
});
