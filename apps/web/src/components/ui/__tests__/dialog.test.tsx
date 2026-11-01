import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../dialog.js";

afterEach(cleanup);

describe("Dialog", () => {
  it("reserves a safe area for the close button in custom headers", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader className="px-6">
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    const header = screen.getByText("Settings").parentElement;
    expect(header?.className).toContain("px-6");
    expect(header?.className).toContain("pr-14");

    const closeButton = document.querySelector('[data-slot="dialog-close"]');
    expect(closeButton).not.toBeNull();
    expect(closeButton?.className).toContain("size-8");
    expect(closeButton?.className).toContain("z-10");
  });

  it("lets specialized dialogs place the close action outside the overlay", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Preview</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  });

  it("restores pointer access when a consent dialog remounts already open", async () => {
    const allow = vi.fn();
    const consent = (requested: boolean, ready: boolean) =>
      requested ? (
        <Dialog open={ready}>
          <DialogContent>
            <DialogTitle>Page consent</DialogTitle>
            <button onClick={allow}>Allow capabilities</button>
          </DialogContent>
        </Dialog>
      ) : null;
    // First selection hashes the content before opening; after revocation the
    // same content is already hashed, so the replacement root starts open.
    const view = render(consent(true, false));
    view.rerender(consent(true, true));
    await waitFor(() =>
      expect(getComputedStyle(screen.getByRole("dialog")).pointerEvents).toBe(
        "auto",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow capabilities" }));
    view.rerender(consent(false, false));
    expect(document.body.style.pointerEvents).not.toBe("none");
    view.rerender(consent(true, true));
    const dialog = screen.getByRole("dialog");
    const button = screen.getByRole("button", { name: "Allow capabilities" });
    await waitFor(() => {
      expect(getComputedStyle(dialog).pointerEvents).toBe("auto");
      expect(getComputedStyle(button).pointerEvents).toBe("auto");
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(button);
    expect(allow).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
