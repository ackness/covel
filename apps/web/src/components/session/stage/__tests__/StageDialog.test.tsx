import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StageDialog } from "../StageDialog.js";

afterEach(cleanup);

const baseProps = {
  turnId: "turn-1",
  storyText: "Mio speaks.\n\nRin answers.\n\nThe wind quiets.",
  streamEnded: true,
  autoPlay: false,
  reducedMotion: true,
  onAllRead: vi.fn(),
};

describe("StageDialog", () => {
  it("changes the nameplate at each paragraph and removes it for narration", () => {
    render(
      <StageDialog {...baseProps} paragraphSpeakers={["Mio", "Rin", null]} />,
    );
    expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe("Mio");
    const advance = screen.getByRole("button");
    fireEvent.click(advance);
    expect(screen.getByTestId("stage-dialog-speaker").textContent).toBe("Rin");
    expect(screen.getByText(/Rin answers/)).toBeDefined();
    fireEvent.click(advance);
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    expect(screen.getByText("The wind quiets.")).toBeDefined();
  });

  it("reads legacy restored prose without attributing it to an actor", () => {
    render(<StageDialog {...baseProps} />);
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByTestId("stage-dialog-speaker")).toBeNull();
    expect(screen.getByText(/Rin answers/)).toBeDefined();
  });
});
