import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReasoningDisclosure } from "../reasoning-disclosure.js";
afterEach(cleanup);

it("starts collapsed and renders returned text safely when expanded", () => {
  const { container, rerender } = render(
    <ReasoningDisclosure
      entries={[
        {
          id: "one",
          content: '<script>alert("fixture")</script>',
          label: "Story",
        },
      ]}
    />,
  );
  const details = screen.getByTestId("reasoning-disclosure");
  expect(details.hasAttribute("open")).toBe(false);
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(container.querySelector("summary")!);
  rerender(
    <ReasoningDisclosure
      entries={[
        { id: "one", content: "summary", label: "Story" },
        { id: "two", content: "next", label: "Plugin" },
      ]}
    />,
  );
  expect(screen.getByText("summary")).not.toBeNull();
  expect(screen.getByText("next")).not.toBeNull();
});

it("does not render an empty thinking panel", () => {
  const { container } = render(
    <ReasoningDisclosure entries={[{ id: "one", content: " \n" }]} />,
  );
  expect(container.innerHTML).toBe("");
});
