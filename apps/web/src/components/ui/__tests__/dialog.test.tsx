import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
