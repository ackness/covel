import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChoiceHotkeys } from "../use-choice-hotkeys.js";

const picked = vi.fn();

function Harness({ enabled = true }: { readonly enabled?: boolean }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useChoiceHotkeys(container, enabled);
  return (
    <div ref={setContainer}>
      <div data-turn-current="false">
        <button className="ui-choice" onClick={() => picked("past")} />
      </div>
      <div data-turn-current="true">
        <button className="ui-choice" onClick={() => picked("first")} />
        <button className="ui-choice" data-folded onClick={() => picked("x")} />
        <button className="ui-choice" disabled onClick={() => picked("y")} />
        <button className="ui-choice" onClick={() => picked("second")} />
        <input aria-label="draft" />
      </div>
    </div>
  );
}

beforeEach(() => {
  picked.mockReset();
  // jsdom lays nothing out; stand in for "folded options have no boxes".
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return (this.hasAttribute("data-folded")
        ? []
        : [{}]) as unknown as DOMRectList;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("picks the n-th visible option of the current turn", () => {
  render(<Harness />);
  // A folded option has no number; a disabled one keeps its number (2) but
  // does not answer, so the numbers match what is drawn.
  fireEvent.keyDown(document.body, { key: "3" });
  expect(picked.mock.calls).toEqual([["second"]]);
  fireEvent.keyDown(document.body, { key: "1" });
  expect(picked.mock.calls).toEqual([["second"], ["first"]]);
  fireEvent.keyDown(document.body, { key: "2" });
  fireEvent.keyDown(document.body, { key: "4" });
  expect(picked).toHaveBeenCalledTimes(2);
});

it("stays out of the way of typing, shortcuts, dialogs and running turns", () => {
  const view = render(<Harness />);
  fireEvent.keyDown(view.getByLabelText("draft"), { key: "1" });
  fireEvent.keyDown(document.body, { key: "1", metaKey: true });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  fireEvent.keyDown(document.body, { key: "1" });
  dialog.remove();
  view.rerender(<Harness enabled={false} />);
  fireEvent.keyDown(document.body, { key: "1" });
  expect(picked).not.toHaveBeenCalled();
});
