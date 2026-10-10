import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorldDocumentPanel } from "../world-document-panel.js";

const world = {
  id: "world-a",
  name: "World A",
  description: "A short summary.",
  createdAt: "2026-01-01",
};

describe("WorldDocumentPanel", () => {
  it("does not show the narrator-only parts of the lore", async () => {
    const { container } = render(
      <WorldDocumentPanel
        world={{
          ...world,
          lore: "## Greyreed\n\nA village by the marsh.\n\n<!-- narrator-only -->\n\n## Secrets\n\nThe keeper put the lamp out herself.\n\n<!-- /narrator-only -->\n\n## Opening\n\nRain.",
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Opening" })).toBeTruthy(),
    );
    expect(container.textContent).toContain("A village by the marsh.");
    expect(container.textContent).not.toContain("Secrets");
    expect(container.textContent).not.toContain("keeper");
    expect(container.textContent).not.toContain("narrator-only");
  });

  it("shows the lore of the session's language edition", async () => {
    const { container } = render(
      <WorldDocumentPanel
        locale="en-US"
        world={{
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
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Greyreed" })).toBeTruthy(),
    );
    expect(container.textContent).not.toContain("沼泽");
    expect(container.textContent).not.toContain("keeper");
  });

  it("shows the summary when all of the lore is narrator-only", () => {
    const { container } = render(
      <WorldDocumentPanel
        world={{
          ...world,
          lore: "<!-- narrator-only -->\n\nThe keeper put the lamp out herself.",
        }}
      />,
    );
    expect(container.textContent).toContain("A short summary.");
    expect(container.textContent).not.toContain("keeper");
  });
});
