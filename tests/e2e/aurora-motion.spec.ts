import { expect, test } from "@playwright/test";
import { seedBrowserSettings } from "./helpers/player.js";

test.beforeEach(async ({ page }) => {
  await seedBrowserSettings(page, {
    "ui.onboardedVersion": 3,
    "ui.locale": "en-US",
    "ui.appearance": "aurora",
    "ui.scheme": "dark",
  });
  await page.goto("/session");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "aurora");
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.body, "::after").animationName,
      ),
    )
    .toBe("aurora-drift");
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1080 },
]) {
  test(`gradient stays fixed while its layer rotates without exposing edges at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const frames = await page.evaluate(async () => {
      const animation = document
        .getAnimations()
        .find(
          (candidate) =>
            (candidate as CSSAnimation).animationName === "aurora-drift",
        )!;
      animation.pause();
      const duration = Number(animation.effect!.getTiming().duration);
      const frames = [];
      for (const phase of [0, 0.125, 0.25, 0.375, 0.5]) {
        animation.currentTime = duration * phase;
        await new Promise(requestAnimationFrame);
        const style = getComputedStyle(document.body, "::after");
        const inverse = new DOMMatrix(style.transform).inverse();
        const halfWidth = parseFloat(style.width) / 2;
        const halfHeight = parseFloat(style.height) / 2;
        const edgeClearance = Math.min(
          ...[
            [0, 0],
            [innerWidth, 0],
            [0, innerHeight],
            [innerWidth, innerHeight],
          ].map(([x, y]) => {
            const corner = inverse.transformPoint(
              new DOMPoint(x! - innerWidth / 2, y! - innerHeight / 2),
            );
            return Math.min(
              halfWidth - Math.abs(corner.x),
              halfHeight - Math.abs(corner.y),
            );
          }),
        );
        frames.push({
          background: style.backgroundImage,
          transform: style.transform,
          translate: style.translate,
          centerX: parseFloat(style.left),
          centerY: parseFloat(style.top),
          edgeClearance,
          overflow: document.documentElement.scrollWidth - innerWidth,
        });
      }
      return frames;
    });
    expect(new Set(frames.map((frame) => frame.background)).size).toBe(1);
    expect(frames[0]!.background).toContain("conic-gradient");
    expect(new Set(frames.map((frame) => frame.transform)).size).toBe(5);
    for (const frame of frames) {
      expect(frame.translate).toBe("-50% -50%");
      expect(frame.centerX).toBeCloseTo(viewport.width / 2, 1);
      expect(frame.centerY).toBeCloseTo(viewport.height / 2, 1);
      expect(frame.edgeClearance).toBeGreaterThanOrEqual(179);
      expect(frame.overflow).toBe(0);
    }
  });
}

test("motion stays active, responds to turn state and respects reduced motion", async ({
  page,
}) => {
  const readMotion = () =>
    page.evaluate(() => {
      const style = getComputedStyle(document.body, "::after");
      return {
        name: style.animationName,
        duration: style.animationDuration,
        opacity: style.opacity,
        transform: style.transform,
      };
    });
  await page.evaluate(() => {
    document.documentElement.dataset.turn = "idle";
  });
  await expect
    .poll(readMotion)
    .toMatchObject({ name: "aurora-drift", duration: "42s", opacity: "0.5" });
  const first = await readMotion();
  await expect
    .poll(async () => (await readMotion()).transform)
    .not.toBe(first.transform);
  await page.evaluate(() => {
    document.documentElement.dataset.turn = "executing";
  });
  await expect
    .poll(readMotion)
    .toMatchObject({ name: "aurora-drift", duration: "14s", opacity: "0.85" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(readMotion)
    .toMatchObject({ name: "none", transform: "none" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(readMotion)
    .toMatchObject({ name: "aurora-drift", duration: "14s" });
});
