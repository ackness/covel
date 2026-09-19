import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { StateTableEntry } from "@/services/api.js";
import { DatabasePanel } from "../database-panel.js";

const api = vi.hoisted(() => ({ listStateTables: vi.fn() }));
vi.mock("@/services/api.js", () => api);

function tables(name: string): StateTableEntry[] {
  return [{ name, fields: [], data: {} }];
}

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

for (const trigger of ["automatic refresh", "session switch"] as const) {
  it.each(["success", "failure"] as const)(
    `ignores a late manual %s after ${trigger}`,
    async (outcome) => {
      let resolve!: (rows: StateTableEntry[]) => void;
      let reject!: (error: Error) => void;
      const manual = new Promise<StateTableEntry[]>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      api.listStateTables
        .mockResolvedValueOnce(tables("initial-table"))
        .mockReturnValueOnce(manual)
        .mockResolvedValueOnce(tables("latest-table"));
      const view = render(
        <DatabasePanel sessionId="session-a" refreshKey={0} />,
      );
      expect(await screen.findByText("initial-table")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(api.listStateTables).toHaveBeenCalledTimes(2));
      view.rerender(
        <DatabasePanel
          sessionId={trigger === "session switch" ? "session-b" : "session-a"}
          refreshKey={trigger === "automatic refresh" ? 1 : 0}
        />,
      );
      expect(await screen.findByText("latest-table")).toBeTruthy();
      await act(async () => {
        if (outcome === "success") resolve(tables("obsolete-table"));
        else reject(new Error("obsolete failure"));
      });
      expect(screen.getByText("latest-table")).toBeTruthy();
      expect(screen.queryByText("obsolete-table")).toBeNull();
      expect(screen.queryByText(/obsolete failure/)).toBeNull();
    },
  );
}

it("retries the current error through the same refresh path", async () => {
  api.listStateTables
    .mockRejectedValueOnce(new Error("current failure"))
    .mockResolvedValueOnce(tables("recovered-table"));
  render(<DatabasePanel sessionId="session-a" />);
  expect(await screen.findByText(/current failure/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("recovered-table")).toBeTruthy();
  expect(screen.queryByText(/current failure/)).toBeNull();
});
