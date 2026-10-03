import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import { indexByCapability, PluginShowcase } from "../PluginShowcase.js";

const api = vi.hoisted(() => ({ listPlugins: vi.fn() }));

vi.mock("@/services/api.js", () => ({ listPlugins: api.listPlugins }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "en-US" },
  }),
}));

function plugin(
  id: string,
  provides: PluginSummary["provides"],
  runtimes: readonly { outputContract?: string; stage?: string }[] = [],
  source: PluginSummary["source"] = "builtin",
): PluginSummary {
  return {
    id,
    displayName: { en: `${id} name` },
    description: { en: `${id} description` },
    source,
    provides,
    runtimes,
  } as unknown as PluginSummary;
}

/** One provider per showcase capability, as the bundled plugins declare them. */
const bundled = [
  plugin(
    "dialogue",
    ["narrative-engine@1"],
    [{ outputContract: "narrative-engine@1", stage: "narrative" }],
  ),
  plugin(
    "story",
    [{ contract: "narrative-engine@1", default: true }],
    [{ outputContract: "narrative-engine@1", stage: "narrative" }],
  ),
  plugin(
    "world",
    ["world-data-provider@1"],
    [{ outputContract: "world-data-provider@1", stage: "setup" }],
  ),
  plugin(
    "events",
    ["story-event-cue@1"],
    [{ outputContract: "story-event-cue@1", stage: "pre-turn" }],
  ),
  plugin(
    "facts",
    ["world-ir-provider@1"],
    [{ outputContract: "world-ir-provider@1", stage: "post-turn" }],
  ),
  plugin(
    "dice",
    ["action-check@1"],
    [{ outputContract: "action-check@1", stage: "pre-turn" }],
  ),
  plugin(
    "cast",
    [{ contract: "character-creation@1", default: true }],
    [{ outputContract: "character-creation@1", stage: "setup" }],
  ),
];

describe("indexByCapability", () => {
  it("prefers the default provider, then builtin, and reads the runtime's stage", () => {
    const index = indexByCapability([
      plugin("community-dice", ["action-check@1"], [], "community"),
      ...bundled,
    ]);

    expect(index.get("narrative-engine@1")).toMatchObject({
      id: "story",
      stage: "narrative",
    });
    expect(index.get("action-check@1")).toMatchObject({
      id: "dice",
      stage: "pre-turn",
    });
  });
});

describe("PluginShowcase", () => {
  afterEach(() => {
    cleanup();
    api.listPlugins.mockReset();
  });

  it("fills every tile from the plugins that provide its capability", async () => {
    api.listPlugins.mockResolvedValue(bundled);
    render(<PluginShowcase />);

    await waitFor(() => expect(screen.getByText("story name")).toBeTruthy());
    for (const id of ["world", "events", "facts", "dice", "cast"]) {
      expect(screen.getByText(`${id} description`)).toBeTruthy();
    }
    expect(screen.queryByText(/Awaiting a plugin/)).toBeNull();
    expect(screen.getAllByText("Pre-Turn")).toHaveLength(2);
  });

  it("describes the capabilities when no backend answers", async () => {
    api.listPlugins.mockRejectedValue(new Error("offline"));
    render(<PluginShowcase />);

    await waitFor(() => expect(api.listPlugins).toHaveBeenCalled());
    expect(screen.queryByText(/Awaiting a plugin/)).toBeNull();
    expect(screen.getByText(/Produces the main narrative output/)).toBeTruthy();
  });

  it("marks a capability no loaded plugin provides", async () => {
    api.listPlugins.mockResolvedValue(
      bundled.filter((entry) => entry.id !== "dice"),
    );
    render(<PluginShowcase />);

    await waitFor(() =>
      expect(screen.getAllByText(/Awaiting a plugin/)).toHaveLength(1),
    );
  });
});
