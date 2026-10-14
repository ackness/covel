import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { UnsavedNarratives } from "../unsaved-narratives.js";
import type { ExecutionRecovery } from "@/stores/session-store/types.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
const messages = [
  {
    id: "stream_t_story",
    role: "assistant" as const,
    content: "A half-told story",
    timestamp: "",
    turnId: "t",
  },
];
const recovery: ExecutionRecovery = {
  sessionId: "s",
  checking: false,
  hydrating: false,
  status: {
    state: "failed",
    turnId: "t",
    retry: { type: "retry_turn", payload: {} },
  },
};
it("labels local prose and retries only on the player's click", () => {
  const onRetry = vi.fn();
  const view = render(
    <UnsavedNarratives
      messages={messages}
      recovery={recovery}
      executing={false}
      onRetry={onRetry}
    />,
  );
  expect(screen.getByText("Unsaved")).toBeTruthy();
  expect(screen.getByText("A half-told story")).toBeTruthy();
  expect(onRetry).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "Retry unfinished turn" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
  view.rerender(
    <UnsavedNarratives
      messages={messages}
      recovery={null}
      executing={true}
      onRetry={onRetry}
    />,
  );
  expect(screen.getByText("A half-told story")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it.each([
  { ...recovery, checking: true },
  { ...recovery, error: "offline" },
  { ...recovery, status: { ...recovery.status!, turnId: "other" } },
  { ...recovery, status: { ...recovery.status!, state: "running" as const } },
])("does not offer an unsafe or unrelated retry", (observation) => {
  render(
    <UnsavedNarratives
      messages={messages}
      recovery={observation}
      executing={false}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});
