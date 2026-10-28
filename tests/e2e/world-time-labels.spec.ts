import { expect, test } from "@playwright/test";
import {
  ONBOARDING_VERSION,
  seedBrowserSettings,
  useServerWorlds,
} from "./helpers/player.js";

for (const locale of ["en-US", "zh-CN"] as const) {
  for (const kind of ["phases", "calendar"] as const) {
    test(`portable ${kind} time rules resolve labels and survive reload (${locale})`, async ({
      page,
    }, testInfo) => {
      await seedBrowserSettings(page, {
        "ui.onboardedVersion": ONBOARDING_VERSION,
        "ui.locale": locale,
      });
      await useServerWorlds(page);
      const worldId = `time-labels-${crypto.randomUUID()}`;
      const definition =
        kind === "phases"
          ? {
              kind,
              name: { en: "Tidal clock", zh: "潮汐时钟" },
              cycleLabel: { en: "Tidal cycle", zh: "潮轮" },
              phases: [
                { en: "High tide", zh: "涨潮" },
                { en: "Low tide", zh: "退潮" },
                { en: "Slack tide", zh: "平潮" },
                { en: "Rising tide", zh: "初涨" },
                { en: "Falling tide", zh: "初落" },
                { en: "Night tide", zh: "夜潮" },
              ],
              initial: { cycle: 2, phase: 0 },
              evolution: {
                mode: "forward",
                defaultStep: 1,
                maxStep: 10,
                prompt: {
                  en: "Tides change once per scene.",
                  zh: "每个场景推进一次潮汐。",
                },
              },
            }
          : {
              kind,
              name: { en: "Station clock", zh: "空间站时钟" },
              calendar: {
                era: { en: "Station era", zh: "站历" },
                months: [{ name: { en: "First month", zh: "一月" }, days: 30 }],
                weekdays: [
                  { en: "Firstday", zh: "始日" },
                  { en: "Secondday", zh: "次日" },
                  { en: "Thirdday", zh: "三日" },
                  { en: "Fourthday", zh: "四日" },
                  { en: "Fifthday", zh: "五日" },
                  { en: "Sixthday", zh: "六日" },
                  { en: "Lastday", zh: "终日" },
                ],
                hoursPerDay: 24,
                minutesPerHour: 60,
              },
              initial: {
                year: 1,
                month: 1,
                day: 1,
                hour: 6,
                minute: 4,
                weekday: 0,
              },
              evolution: {
                mode: "forward",
                defaultStep: 1,
                maxStep: 10,
                prompt: {
                  en: "Minutes pass with each scene.",
                  zh: "每个场景推进一分钟。",
                },
              },
            };
      const createdWorld = await page.request.post("/api/worlds", {
        data: {
          id: worldId,
          name: "Portable time labels",
          locale,
          metadata: {
            contractData: [
              {
                contract: "world.time-definition@1",
                key: "world",
                value: { id: "world", definition },
              },
            ],
          },
        },
      });
      expect(createdWorld.ok(), await createdWorld.text()).toBeTruthy();
      let sessionId: string | undefined;
      try {
        const createdSession = await page.request.post("/api/sessions", {
          data: {
            worldId,
            locale,
            plugins: ["narrator", "world-time"],
          },
        });
        expect(createdSession.ok(), await createdSession.text()).toBeTruthy();
        sessionId = ((await createdSession.json()) as { id: string }).id;
        await page.goto(`/session?sid=${sessionId}`);
        const panelName = locale === "zh-CN" ? "时间规则" : "Time rules";
        const labels =
          kind === "phases"
            ? locale === "zh-CN"
              ? ["潮轮", "涨潮", "退潮"]
              : ["Tidal cycle", "High tide", "Low tide"]
            : locale === "zh-CN"
              ? ["站历", "始日", "终日"]
              : ["Station era", "Firstday", "Lastday"];
        for (let reload = 0; reload < 2; reload++) {
          if (reload) await page.reload();
          await page.getByRole("tab", { name: panelName, exact: true }).click();
          const panel = page.getByRole("tabpanel").filter({
            has: page.getByText(labels[0]!, { exact: true }).first(),
          });
          for (const label of labels)
            await expect(
              panel.getByText(label, { exact: true }).first(),
            ).toBeVisible();
          const items =
            kind === "phases"
              ? definition.phases!
              : definition.calendar!.weekdays;
          const badges = panel.locator(".ui-chip");
          await expect(badges).toHaveCount(items.length);
          // Multiple names occupy separate grid cells and wrap into rows.
          const boxes = await badges.evaluateAll((nodes) =>
            nodes.map((node) => {
              const box = node.getBoundingClientRect();
              return { top: box.top, left: box.left };
            }),
          );
          expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
          expect(boxes[2]!.top).toBeGreaterThan(boxes[0]!.top);
          await expect(panel).not.toContainText("[object Object]");
          const prompt =
            locale === "zh-CN"
              ? definition.evolution.prompt.zh
              : definition.evolution.prompt.en;
          await expect(panel.getByText(prompt, { exact: true })).toHaveCount(1);
          await expect(
            panel.getByText(kind === "phases" ? "2 ·" : "1 · 1/1 06:04", {
              exact: true,
            }),
          ).toBeVisible();
        }
        await page.screenshot({
          path: testInfo.outputPath(`time-${kind}-${locale}.png`),
          fullPage: true,
        });
      } finally {
        if (sessionId) await page.request.delete(`/api/sessions/${sessionId}`);
        await page.request.delete(`/api/worlds/${worldId}`);
      }
    });
  }
}
