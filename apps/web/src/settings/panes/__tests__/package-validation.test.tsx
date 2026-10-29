import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageValidationReport } from "@covel/shared";
import i18n from "@/i18n";
import { validatePackage } from "@/services/api/package-validation.js";
import {
  PackageValidationButton,
  PackageValidationZip,
} from "../PackageValidation.js";
import { renderPlainText } from "../package-validation-model.js";
vi.mock("@/services/api/package-validation.js", () => ({
  validatePackage: vi.fn(),
}));
const report: PackageValidationReport = {
  kind: "plugin",
  id: "probe",
  ok: false,
  counts: { errors: 1, warnings: 1 },
  summary: { languages: "en" },
  issues: [
    { severity: "warning", code: "unknown-warning", message: "Warning text" },
    {
      severity: "error",
      code: "unknown-error",
      file: "PLUGIN.md",
      field: "future",
      message: "Error text",
      hint: "Remove future",
    },
  ],
};
beforeEach(async () => {
  vi.mocked(validatePackage).mockReset().mockResolvedValue(report);
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("package validation", () => {
  it("validates the installed id and displays grouped issues and languages", async () => {
    render(<PackageValidationButton kind="plugin" id="probe" />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(validatePackage).toHaveBeenCalledWith("plugin", {
      kind: "installed",
      id: "probe",
    });
    expect(await screen.findByText("1 errors, 1 warnings")).toBeTruthy();
    expect(screen.getByText("PLUGIN.md")).toBeTruthy();
    expect(screen.getByText("future")).toBeTruthy();
    expect(screen.getByText("Error text")).toBeTruthy();
    expect(screen.getByText("Remove future")).toBeTruthy();
    expect(screen.getByText("Languages: en")).toBeTruthy();
    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["Errors · PLUGIN.md", "Warnings · Package"]);
  });
  it("shows an ok verdict", async () => {
    vi.mocked(validatePackage).mockResolvedValue({
      kind: "world",
      ok: true,
      counts: { errors: 0, warnings: 0 },
      issues: [],
    });
    render(<PackageValidationButton kind="world" id="sample" />);
    fireEvent.click(screen.getByText("Validate"));
    expect(await screen.findByText("No errors")).toBeTruthy();
  });
  it("disables the button and shows the pending state", async () => {
    let resolve: (value: PackageValidationReport) => void = () => {};
    vi.mocked(validatePackage).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<PackageValidationButton kind="plugin" id="probe" />);
    fireEvent.click(screen.getByText("Validate"));
    expect(
      (screen.getByRole("button", { name: "Validating…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    resolve(report);
    await screen.findByText("Error text");
  });
  it("shows server errors in the pane", async () => {
    vi.mocked(validatePackage).mockRejectedValue(
      new Error("Validation unavailable"),
    );
    render(<PackageValidationButton kind="plugin" id="probe" />);
    fireEvent.click(screen.getByText("Validate"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Validation unavailable",
    );
  });
  it("copies a plain-text report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<PackageValidationButton kind="plugin" id="probe" />);
    fireEvent.click(screen.getByText("Validate"));
    fireEvent.click(await screen.findByText("Copy report"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(renderPlainText(report)),
    );
    expect(await screen.findByText("Report copied")).toBeTruthy();
  });
  it("rejects non-ZIP filenames, including dropped files", () => {
    render(<PackageValidationZip />);
    const input = screen.getByLabelText("Choose or drop a ZIP");
    fireEvent.change(input, {
      target: { files: [new File(["bad"], "package.txt")] },
    });
    expect(screen.getByRole("alert").textContent).toBe("Choose a .zip file");
    expect(validatePackage).not.toHaveBeenCalled();
    const label = input.closest("label");
    if (!label) throw new Error("Missing label");
    fireEvent.drop(label, {
      dataTransfer: { files: [new File(["bad"], "package.exe")] },
    });
    expect(validatePackage).not.toHaveBeenCalled();
  });
  it("validates the chosen ZIP kind without making installation requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PackageValidationZip />);
    fireEvent.click(screen.getByRole("button", { name: "World" }));
    const file = new File(["zip"], "world.ZIP");
    fireEvent.change(screen.getByLabelText("Choose or drop a ZIP"), {
      target: { files: [file] },
    });
    expect(validatePackage).toHaveBeenCalledWith("world", {
      kind: "upload",
      file,
    });
    await screen.findByText("Error text");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
