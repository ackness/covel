import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { StImportResult } from "@covel/shared";
import { StImportCard } from "../StImportCard.js";
import { importStContent } from "@/services/api/st-import.js";
vi.mock("@/services/api/st-import.js", () => ({ importStContent: vi.fn() }));
vi.mock("@/hooks/useLocalePreference.js", () => ({
  useLocalePreference: () => ({ locale: "en-US" }),
}));
const preview: StImportResult = {
  ok: true,
  preview: true,
  kind: "world",
  id: "mira",
  restartRequired: false,
  report: {
    sources: [{ file: "mira.json", kind: "card-v2" }],
    world: { id: "mira", name: "Mira", locale: "en-US", summary: "Keeper" },
    counts: { characters: 1, loreEntries: 2, hasCover: false },
    items: [
      {
        level: "warning",
        code: "alternate-greetings-unsupported",
        message: "Fallback",
        count: 2,
      },
    ],
  },
};
beforeEach(async () => {
  vi.mocked(importStContent).mockReset().mockResolvedValue(preview);
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
function chooseFiles() {
  fireEvent.change(screen.getByLabelText("Character cards and lorebooks"), {
    target: { files: [new File(["{}"], "mira.json")] },
  });
}
it("previews then imports, clears the form and calls onImported", async () => {
  const onImported = vi.fn();
  render(<StImportCard busy={false} onImported={onImported} />);
  expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  chooseFiles();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(await screen.findByText("Mira · mira")).toBeTruthy();
  expect(screen.getByText(/Alternate greetings omitted/).textContent).toContain(
    "(2)",
  );
  vi.mocked(importStContent).mockResolvedValue({ ...preview, preview: false });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status").textContent).toBe("World imported.");
  expect(vi.mocked(importStContent).mock.calls[0]?.[0]).toMatchObject({
    preview: true,
    locale: "en-US",
  });
  expect(vi.mocked(importStContent).mock.calls[1]?.[0]).toMatchObject({
    preview: false,
  });
  expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
});
it("shows server errors and never offers Import after failure", async () => {
  vi.mocked(importStContent).mockRejectedValue(new Error("File is invalid"));
  render(<StImportCard busy={false} onImported={vi.fn()} />);
  chooseFiles();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "File is invalid",
  );
  expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
});
it("defaults to the interface locale and invalidates a changed preview", async () => {
  render(<StImportCard busy={false} onImported={vi.fn()} />);
  expect(
    (screen.getByLabelText("Content language") as HTMLSelectElement).value,
  ).toBe("en-US");
  chooseFiles();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("Mira · mira");
  fireEvent.change(screen.getByLabelText("World name (optional)"), {
    target: { value: "Other" },
  });
  expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
});
it("disables the card while another installer is busy", () => {
  render(<StImportCard busy onImported={vi.fn()} />);
  expect(
    screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
});
