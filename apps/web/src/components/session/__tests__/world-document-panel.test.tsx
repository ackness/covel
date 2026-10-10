import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateAllWorldRecords,
  primeWorldRecord,
} from "@/services/world-records.js";
import { WorldDocumentPanel } from "../world-document-panel.js";

vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({ getWorld: async () => null }),
}));

const world = {
  id: "world-a",
  name: "World A",
  description: "A short summary.",
  createdAt: "2026-01-01",
};

// The panel gets the summary and reads the lore from the full record.
function renderPanel(
  full: typeof world & Record<string, unknown>,
  locale?: string,
) {
  primeWorldRecord(full);
  const { lore: _lore, ...summary } = full;
  return render(<WorldDocumentPanel locale={locale} world={summary} />);
}

beforeEach(() => invalidateAllWorldRecords());

describe("WorldDocumentPanel", () => {
  it("does not show the narrator-only parts of the lore", async () => {
    const { container } = renderPanel({
      ...world,
      lore: "## Greyreed\n\nA village by the marsh.\n\n<!-- narrator-only -->\n\n## Secrets\n\nThe keeper put the lamp out herself.\n\n<!-- /narrator-only -->\n\n## Opening\n\nRain.",
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Opening" })).toBeTruthy(),
    );
    expect(container.textContent).toContain("A village by the marsh.");
    expect(container.textContent).not.toContain("Secrets");
    expect(container.textContent).not.toContain("keeper");
    expect(container.textContent).not.toContain("narrator-only");
  });

  it("shows the lore of the session's language edition", async () => {
    const { container } = renderPanel(
      {
        ...world,
        locale: "zh-CN",
        lore: "## 灰苇\n\n沼泽边的村子。",
        metadata: {
          localizedText: {
            lore: {
              "en-US":
                "## Greyreed\n\nA village by the marsh.\n\n<!-- narrator-only -->\n\nThe keeper lies.",
            },
          },
        },
      },
      "en-US",
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Greyreed" })).toBeTruthy(),
    );
    expect(container.textContent).not.toContain("沼泽");
    expect(container.textContent).not.toContain("keeper");
  });

  it("shows the summary when all of the lore is narrator-only", () => {
    const { container } = renderPanel({
      ...world,
      lore: "<!-- narrator-only -->\n\nThe keeper put the lamp out herself.",
    });
    expect(container.textContent).toContain("A short summary.");
    expect(container.textContent).not.toContain("keeper");
  });
});
