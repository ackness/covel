import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoSection } from "../DemoSection.js";
import { Hero } from "../Hero.js";
import { PipelineScrolly } from "../PipelineScrolly.js";

const media = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => media.reducedMotion,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("landing responsive media", () => {
  beforeEach(() => {
    media.reducedMotion = false;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("layers the hero video over its fallback image", () => {
    const { container } = render(<Hero />);
    const video = container.querySelector("video");
    const fallback = container.querySelector(
      'img[src="/visuals/worlds/mistport.webp"]',
    );

    expect(video?.className).toContain("absolute inset-0");
    expect(fallback?.className).toContain("absolute inset-0");
  });

  it("does not autoplay landing videos when reduced motion is requested", () => {
    media.reducedMotion = true;
    const { container } = render(
      <>
        <Hero />
        <DemoSection />
      </>,
    );
    const videos = [...container.querySelectorAll("video")];

    expect(videos).toHaveLength(2);
    expect(videos.every((video) => !video.autoplay)).toBe(true);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("keeps every mobile pipeline step visible with compact spacing", () => {
    const { container } = render(<PipelineScrolly scrollRoot={null} />);
    const steps = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.closest("li"));
    const textSteps = container.querySelector("ol.space-y-12");

    expect(textSteps?.className).toContain("md:space-y-[42vh]");
    expect(textSteps?.className).not.toContain("md:space-y-[55vh]");
    expect(steps).toHaveLength(6);
    expect(steps.every((step) => step?.classList.contains("opacity-100"))).toBe(
      true,
    );
  });
});
