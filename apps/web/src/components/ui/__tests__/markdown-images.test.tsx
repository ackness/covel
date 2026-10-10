import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageScopeContext } from "@/lib/external-images.js";
import { Markdown } from "../markdown.js";

const settings = vi.hoisted(() => ({
  value: {} as Record<string, string[]>,
  set: vi.fn(),
}));

vi.mock("@/settings/use-settings.js", () => ({
  useSetting: () => [settings.value, settings.set],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  settings.value = {};
  settings.set.mockReset();
});
afterEach(cleanup);

const EXTERNAL = "![a map](https://cdn.example/map.png?leak=secret)";

describe("Markdown images", () => {
  it("does not request an image on another origin until the player asks", async () => {
    render(<Markdown>{EXTERNAL}</Markdown>);
    await screen.findByText(/externalImageHeld/);
    expect(document.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByText("session.externalImageLoad"));
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "https://cdn.example/map.png?leak=secret",
    );
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("loads images the app serves itself and inline images at once", async () => {
    render(
      <Markdown>
        {"![a](/api/sessions/s1/media/m1)\n\n![b](data:image/png;base64,AAAA)"}
      </Markdown>,
    );
    await screen.findByAltText("a");
    expect(screen.getByAltText("b").getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(screen.queryByText(/externalImageHeld/)).toBeNull();
  });

  it("loads at once from a host the player allowed for this world", async () => {
    settings.value = { w1: ["cdn.example"] };
    render(
      <ImageScopeContext.Provider value="w1">
        <Markdown>{EXTERNAL}</Markdown>
      </ImageScopeContext.Provider>,
    );
    await screen.findByAltText("a map");
    expect(screen.queryByText(/externalImageHeld/)).toBeNull();
  });

  it("keeps the host held in another world and remembers the choice per world", async () => {
    settings.value = { w1: ["cdn.example"] };
    render(
      <ImageScopeContext.Provider value="w2">
        <Markdown>{EXTERNAL}</Markdown>
      </ImageScopeContext.Provider>,
    );
    await screen.findByText(/externalImageHeld/);
    fireEvent.click(screen.getByText(/externalImageAlways/));
    expect(settings.set).toHaveBeenCalledWith({
      w1: ["cdn.example"],
      w2: ["cdn.example"],
    });
  });

  it("offers no always-allow choice outside a world", async () => {
    render(<Markdown>{EXTERNAL}</Markdown>);
    await screen.findByText(/externalImageHeld/);
    expect(screen.queryByText(/externalImageAlways/)).toBeNull();
  });
});
