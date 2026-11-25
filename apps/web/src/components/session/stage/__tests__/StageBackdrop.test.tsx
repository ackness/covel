import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageBackdrop } from "../StageBackdrop.js";

vi.mock("@/components/Media.js", () => ({
  Media: ({ src }: { src: { id: string } }) => (
    <div data-testid={`media-${src.id}`} />
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("StageBackdrop", () => {
  it("unmounts the previous layer once the crossfade completes", () => {
    vi.useFakeTimers();
    const frame1 = {
      id: "frame-1",
      kind: "image" as const,
      mime: "image/png",
      sha256: "a".repeat(64),
      size: 128,
    };
    const frame2 = {
      id: "frame-2",
      kind: "image" as const,
      mime: "image/png",
      sha256: "b".repeat(64),
      size: 128,
    };

    const { rerender } = render(
      <StageBackdrop
        sessionId="sess-1"
        world={null}
        sceneCurrent={{ ref: frame1 }}
      />,
    );
    expect(screen.getByTestId("media-frame-1")).toBeTruthy();

    rerender(
      <StageBackdrop
        sessionId="sess-1"
        world={null}
        sceneCurrent={{ ref: frame2 }}
      />,
    );
    expect(screen.getByTestId("media-frame-1")).toBeTruthy();
    expect(screen.getByTestId("media-frame-2")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(screen.queryByTestId("media-frame-1")).toBeNull();
    expect(screen.getByTestId("media-frame-2")).toBeTruthy();
  });
});
