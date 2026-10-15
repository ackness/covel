import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { SessionDimensionsPanel } from "../session-dimensions-panel.js";
import { SessionCanvasHero } from "../chat-messages/session-canvas-hero.js";
import type { getSessionView, WorldRecord } from "@/services/api.js";

const session = vi.hoisted(() => ({
  state: {
    gameState: { dimensions: { hp: 5 } },
    session: { id: "session" },
    executing: false,
  },
}));
vi.mock("@/stores/session-store.js", () => ({ useSession: () => session }));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

it("contains invalid active-session dimensions in a local alert", () => {
  render(<SessionDimensionsPanel recoveryOnly />);
  expect(screen.getByRole("alert").textContent).toContain(
    "Dimension controls are unavailable",
  );
});

it("also contains malformed debug snapshots", () => {
  render(
    <SessionDimensionsPanel
      snapshot={
        {
          session: { id: "debug" },
          dimensions: { hp: 5 },
        } as unknown as Awaited<ReturnType<typeof getSessionView>>
      }
    />,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
});

it("keeps the opening scene usable with world labels when dimensions are malformed", () => {
  const onBegin = vi.fn();
  render(
    <SessionCanvasHero
      locale="en-US"
      world={
        {
          id: "harbor",
          name: "Harbor",
          description: "A quiet port",
          tags: ["Mystery"],
        } as WorldRecord
      }
      dimensions={{ hp: 5 }}
      onBegin={onBegin}
      beginLabel="Begin"
      hintLabel="Prepare"
    />,
  );
  expect(screen.getByRole("heading", { name: "Harbor" })).toBeTruthy();
  expect(screen.getByText("Mystery")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Begin" }));
  expect(onBegin).toHaveBeenCalledOnce();
});
