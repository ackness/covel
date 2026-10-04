import { test, expect, type Page } from "@playwright/test";
import {
  startFakeLlmProvider,
  type FakeChatRequest,
  type FakeLlmProvider,
} from "./helpers/fake-llm-provider.js";
import { seedAppSettings } from "./helpers/player.js";

/**
 * AI world generation in the browser, against a provider that runs in this
 * process. No real model is called and no test waits for a real timeout:
 *
 *   - the dialog, the server route, the gateway and its HTTP adapter are real;
 *   - the request is pointed at the fake provider on its way to the server;
 *   - the idle timeout is one second, the lowest value the API accepts.
 *
 * A new world is one model request for each part. The generator takes the
 * section it asked for out of the answer, so one full answer serves every
 * part.
 */

const PROVIDER = "fake";
const PRESET = "fake-world-author";

const WORLD_YAML = `schemaVersion: "1.0"
id: lantern-tide
name: 灯潮港
version: "0.1.0"
summary: 一座靠回收潮汐灯火维生的港城，灯火正在一盏盏熄灭。
defaultLocale: "zh-CN"
supportedLocales: ["zh-CN"]
tags: [mystery, harbor]
pluginPolicy:
  presetId: traditional-story
  preferredTags: []
  requested: []
  recommended: []
dimensions:
  setting:
    name: 港城概况
    schema: { type: string }
    initialValue: 灯潮港建在三道防波堤之间，守灯会掌管潮灯，走私行会控制暗码头。
  opening:
    name: 开场抉择
    schema: { type: string }
    initialValue: 第七盏潮灯在你值夜时熄灭。你可以上报守灯会，或先去暗码头追查偷油的人。
  lampOil:
    name: 灯油
    schema: { type: integer, minimum: 0 }
    initialValue: 12
  tideTokens:
    name: 潮票
    schema: { type: integer, minimum: 0 }
    initialValue: 5
`;

const WORLD_MD = `# 灯潮港

灯潮港的每一盏潮灯都连着一段被记住的航线。灯灭了，那条航线上的船就再也找不到回港的路。

1. 第七盏潮灯熄灭的当晚，值夜记录被人撕掉了一页。
2. 暗码头出现一批烧起来没有影子的灯油。
3. 一艘三年前失踪的船，顺着刚熄灭的那条航线漂了回来。
`;

const CHARACTERS = [
  "  - { schemaVersion: 1, id: lamp-warden, name: 守灯人阿潮, role: npc }",
  "  - { schemaVersion: 1, id: oil-smuggler, name: 油贩老烬, role: npc }",
  "  - { schemaVersion: 1, id: lost-pilot, name: 归航的引水员, role: npc }",
];

/** The whole answer; `characters` is how many of the cast it holds. */
function worldAnswer(characters = CHARACTERS.length): string {
  return [
    "===WORLD_YAML===",
    WORLD_YAML.trim(),
    "===WORLD_MD===",
    WORLD_MD.trim(),
    "===WORLD_PACKAGE_YAML===",
    "characters:",
    ...CHARACTERS.slice(0, characters),
    "lorebook:",
    "  - { id: tide-lamps, content: 每盏潮灯连着一条航线。, strategy: constant }",
    "  - { id: lamp-guild, content: 守灯会掌管灯油的配给。, strategy: selective, keys: [守灯会] }",
    "  - { id: dark-pier, content: 暗码头只在退潮时露出水面。, strategy: selective, keys: [暗码头] }",
    "  - { id: whale-oil, content: 灯油来自深海鲸骨。, strategy: selective, keys: [灯油] }",
    "rules:",
    "  - { id: lamp-cost, content: 点亮一盏潮灯必须消耗灯油。, strategy: constant }",
    "  - { id: no-full-names, content: 夜里在堤上喊出全名会被潮水记住。, strategy: constant }",
    "  - { id: dark-route, content: 熄灭的航线上不会有船平安归来。, strategy: constant }",
    "===END===",
  ].join("\n");
}

/** Which part of the world a request asks for, as the generator names it. */
function partOf(request: FakeChatRequest): string {
  const named = /^Write one part of the world package now: (.+)\.$/m.exec(
    request.messages.join("\n"),
  )?.[1];
  return /`(\w+)` list/.exec(named ?? "")?.[1] ?? named ?? "unknown";
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

let provider: FakeLlmProvider;

/**
 * Point the dialog's request at the fake provider. The request also drops
 * the plugin content of the brief: which plugins offer content depends on
 * the plugins that are loaded, and their schemas are not this spec's subject.
 */
async function useFakeModel(
  page: Page,
  options: { idleTimeoutMs?: number } = {},
) {
  await page.route("**/api/ai/generate-world", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    const brief = { ...(body.brief as Record<string, unknown>) };
    delete brief.contracts;
    const headers = { ...request.headers() };
    // The body changes; the browser's length no longer matches it.
    delete headers["content-length"];
    await route.continue({
      headers: {
        ...headers,
        "x-slot-config": encode({
          customPresets: [
            {
              id: PRESET,
              provider: PROVIDER,
              model: "fake-model",
              baseUrl: provider.baseUrl,
              protocol: "openai-chat-v1",
            },
          ],
        }),
        "x-provider-keys": encode({ [PROVIDER]: "fake-test-key" }),
      },
      postData: JSON.stringify({
        ...body,
        brief,
        model: PRESET,
        ...(options.idleTimeoutMs
          ? { idleTimeoutMs: options.idleTimeoutMs }
          : {}),
      }),
    });
  });
}

/** Open the generator, describe a world, and start the generation. */
async function startGeneration(page: Page) {
  await seedAppSettings(page);
  await page.goto("/session");
  await page.locator("button", { hasText: "AI 创建世界" }).click();
  const dialog = page.locator("[role=dialog]");
  await dialog.locator("#world-prompt").fill("一座靠潮汐灯火维生的港城");
  await dialog.getByRole("button", { name: "开始构筑" }).click();
  return dialog;
}

/**
 * How long a final state may take to show. The generations here end within
 * a few seconds; the limit only keeps a slow machine from failing the spec.
 */
const SETTLED = { timeout: 15_000 };

test.describe("AI world generation with a fake provider", () => {
  // The route admits one generation at a time.
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1280, height: 860 } });

  test.beforeAll(async () => {
    provider = await startFakeLlmProvider();
  });

  test.afterAll(async () => {
    await provider.close();
  });

  test.beforeEach(() => {
    provider.requests.length = 0;
    provider.reply = () => ({ text: worldAnswer() });
  });

  test("shows each part of the world while the model writes it", async ({
    page,
  }) => {
    // The lore stays unfinished until the page has been looked at.
    let finishLore = () => {};
    const loreMayEnd = new Promise<void>((resolve) => {
      finishLore = resolve;
    });
    provider.reply = (request) =>
      partOf(request) === "WORLD_MD"
        ? { text: worldAnswer(), streamMs: 200, hold: loreMayEnd }
        : { text: worldAnswer() };
    await useFakeModel(page);

    const dialog = await startGeneration(page);
    const parts = dialog.locator("li[data-state]");
    await expect
      .poll(
        () =>
          parts.evaluateAll((rows) =>
            rows.map((row) => (row as HTMLElement).dataset.state),
          ),
        SETTLED,
      )
      .toEqual(["done", "active", "pending", "pending", "pending"]);
    await expect(parts).toContainText([
      "世界设定",
      "世界背景",
      "主要角色",
      "世界资料库",
      "世界规则",
    ]);
    // The part in progress says how much of it has arrived.
    await expect(parts.nth(1)).toContainText(/已写 \d+ 字/);
    await expect(dialog.locator("#world-prompt")).toBeDisabled();

    finishLore();
    // A world that meets the brief closes the dialog by itself.
    await expect(dialog).toBeHidden(SETTLED);
    await expect(
      page.locator("article").filter({ hasText: "灯潮港" }),
    ).toBeVisible();
    expect(provider.requests.map(partOf)).toEqual([
      "WORLD_YAML",
      "WORLD_MD",
      "characters",
      "lorebook",
      "rules",
    ]);
  });

  test("finishes a part that takes longer to write than the idle timeout", async ({
    page,
  }) => {
    // The manifest arrives over 2.5 seconds, a piece every 50 ms; the server
    // waits one second for the next piece.
    provider.reply = (request) =>
      partOf(request) === "WORLD_YAML"
        ? { text: worldAnswer(), streamMs: 2_500 }
        : { text: worldAnswer() };
    await useFakeModel(page, { idleTimeoutMs: 1_000 });

    const dialog = await startGeneration(page);
    await expect(dialog).toBeHidden(SETTLED);
    await expect(
      page.locator("article").filter({ hasText: "灯潮港" }),
    ).toBeVisible();
    expect(provider.requests).toHaveLength(5);
  });

  test("ends the generation when the model stops answering", async ({
    page,
  }) => {
    provider.reply = () => ({ text: worldAnswer(), stall: true });
    await useFakeModel(page, { idleTimeoutMs: 1_000 });

    const dialog = await startGeneration(page);
    await expect(dialog.getByText("生成失败")).toBeVisible(SETTLED);
    await expect(dialog).toContainText(
      "The model sent no output for 1 seconds",
    );
    // The error names the setting that makes the wait longer.
    await expect(dialog).toContainText("世界创作：等待模型的时间");
    await expect(dialog.locator("li[data-state]").first()).toHaveAttribute(
      "data-state",
      "failed",
    );
    await expect(dialog.getByRole("button", { name: "重试" })).toBeVisible();
    // The wait is the player's limit: the silent request is not sent again.
    expect(provider.requests).toHaveLength(1);
  });

  test("keeps a world that falls short of the brief on screen", async ({
    page,
  }) => {
    provider.reply = () => ({ text: worldAnswer(2) });
    await useFakeModel(page);

    const dialog = await startGeneration(page);
    await expect(dialog.getByText("世界创建完成！")).toBeVisible(SETTLED);
    await expect(dialog).toContainText("世界已创建，但有以下不足：");
    await expect(dialog).toContainText(
      "generated 2 characters; the brief asks for 3",
    );

    await dialog.getByRole("button", { name: "关闭" }).last().click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator("article").filter({ hasText: "灯潮港" }),
    ).toBeVisible();
  });
});
