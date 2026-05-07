/**
 * Behaviour tests for `<AssetImage>`.
 *
 * Verifies title / subtitle wiring and that the underlying `<Media>` mount
 * receives the right ref / sessionId / mime so signed-URL resolution can
 * reach the right session bucket.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AssetGenerateView } from "@covel/shared";

vi.mock("@/components/Media.js", () => ({
  Media: ({
    src,
    sessionId,
    alt,
    as,
  }: {
    src: { id?: string; mime?: string };
    sessionId: string;
    alt?: string;
    as?: string;
  }) => (
    <div
      data-testid="media-stub"
      data-as={as}
      data-session-id={sessionId}
      data-alt={alt}
      data-mime={src?.mime ?? ""}
      data-id={src?.id ?? ""}
    />
  ),
}));

import { AssetImage } from "../AssetImage.js";

afterEach(() => {
  cleanup();
});

const baseView: AssetGenerateView = {
  id: "prop-1",
  type: "asset.generate",
  sessionId: "sess-1",
  turnId: "turn-1",
  source: { pluginId: "image", runtimeId: "image/runner" },
  ref: {
    id: "a".repeat(64),
    mime: "image/png",
    size: 16,
    url: "https://cdn.example/x.png",
  },
  modality: "image",
  createdAt: "2026-04-26T00:00:00.000Z",
};

describe("<AssetImage>", () => {
  it("passes the MediaRef and sessionId to <Media>", () => {
    render(<AssetImage view={baseView} sessionId="my-session" />);
    const stub = screen.getByTestId("media-stub");
    expect(stub.getAttribute("data-id")).toBe("a".repeat(64));
    expect(stub.getAttribute("data-mime")).toBe("image/png");
    expect(stub.getAttribute("data-session-id")).toBe("my-session");
    expect(stub.getAttribute("data-as")).toBe("image");
  });

  it("uses meta.prompt as title when present", () => {
    render(
      <AssetImage
        view={{ ...baseView, meta: { prompt: "ancient ruins at midnight" } }}
        sessionId="sess-1"
      />,
    );
    expect(screen.getByText("ancient ruins at midnight")).toBeTruthy();
  });

  it("falls back to the modality string when prompt is missing", () => {
    render(<AssetImage view={baseView} sessionId="sess-1" />);
    // We expect either the figure title or the alt to surface the modality.
    expect(screen.getAllByText(/image/i).length).toBeGreaterThan(0);
  });

  it("renders the runtime id as a subtitle", () => {
    render(<AssetImage view={baseView} sessionId="sess-1" />);
    expect(screen.getByText(/image\/runner/)).toBeTruthy();
  });

  it("forwards prompt as alt text on <Media>", () => {
    render(
      <AssetImage
        view={{ ...baseView, meta: { prompt: "neon street" } }}
        sessionId="sess-1"
      />,
    );
    const stub = screen.getByTestId("media-stub");
    expect(stub.getAttribute("data-alt")).toBe("neon street");
  });
});
