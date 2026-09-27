import { createElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryList, SceneCastList } from "../character-renderers.js";
import { MediaGalleryPanel } from "@/components/session/image-plugin-panels/image-gallery-panel.js";
import { JobListPanel } from "@/components/session/image-plugin-panels/image-jobs-panel.js";
import { invokeCatalogAction } from "../catalog-actions.js";
vi.mock("../catalog-actions.js", async (original) => ({
  ...(await original<typeof import("../catalog-actions.js")>()),
  invokeCatalogAction: vi.fn(async () => {}),
}));
vi.mock("../session-context.js", () => ({
  useActiveSessionId: () => "session",
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlot: () => ({
    value: {
      actors: [
        {
          characterId: "hero",
          displayName: "Hero",
          description: "A guide",
          type: "npc",
        },
      ],
    },
  }),
}));
vi.mock("@/components/Media.js", () => ({
  Media: () => <span>projected media</span>,
}));
vi.mock("@/components/MediaPreviewDialog.js", () => ({
  MediaPreviewDialog: () => null,
}));
const action = {
  pluginId: "owner",
  runtimeId: "owner/run",
  payload: { action: "retry" },
};
describe("generic data renderers", () => {
  it("renders entry fields without a domain-specific record envelope", () => {
    render(
      createElement(EntryList, {
        element: {
          type: "EntryList",
          props: {
            items: [
              { id: "a", heading: "Entry", body: "Description", tags: ["tag"] },
            ],
            titleField: "heading",
            descriptionFields: ["body"],
            badgeFields: ["tags"],
          },
        },
      } as never),
    );
    expect(screen.getByText("Entry")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByText("tag")).toBeTruthy();
  });
  it("reads cast presence from the kernel slot", () => {
    render(
      createElement(SceneCastList, {
        element: { type: "SceneCastList", props: {} },
      } as never),
    );
    expect(screen.getByText("Hero")).toBeTruthy();
    expect(screen.getByText("A guide")).toBeTruthy();
  });
  it("maps generic media fields and passes declared rerun actions", async () => {
    render(
      <MediaGalleryPanel
        props={{
          items: [
            {
              key: "media",
              asset: { id: "a".repeat(64), mime: "image/png", size: 1 },
            },
          ],
          idField: "key",
          refField: "asset",
          rerunAction: { ...action, label: "Retry" },
        }}
      />,
    );
    expect(screen.getByText("projected media")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(invokeCatalogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session",
          scope: expect.objectContaining({
            item: expect.objectContaining({ key: "media" }),
          }),
        }),
      ),
    );
  });
  it("renders configurable job details and errors without reading plugin storage", () => {
    render(
      <JobListPanel
        props={{
          items: [
            {
              key: "job",
              state: "running",
              detail: "Working",
              failure: "Problem",
            },
          ],
          idField: "key",
          statusField: "state",
          errorField: "failure",
          fields: [{ path: "detail", label: "Detail" }],
          relatedMedia: {
            items: [
              {
                job: "job",
                ref: { id: "a".repeat(64), mime: "image/png", size: 1 },
              },
            ],
            itemField: "key",
            matchField: "job",
          },
        }}
      />,
    );
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Problem")).toBeTruthy();
    expect(screen.getByText("projected media")).toBeTruthy();
  });
});
