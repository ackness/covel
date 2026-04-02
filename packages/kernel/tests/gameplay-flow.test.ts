/**
 * 完整游戏流程集成测试
 *
 * 模拟一个典型的 TRPG 开局流程，所有 runtime 均通过 LLM 生成内容：
 *
 * Turn 1: session_start（开始游戏）
 *   [story]      story-narrator  → LLM 生成背景故事 → narrative.append
 *   [post_story] init-wizard     → LLM 根据剧情生成角色创建表单 → ui.render
 *   char-tracker  ✗ 不触发（仅监听 user.input）
 *   story-guide   ✗ 不触发（仅监听 user.input）
 *
 * Turn 2: user.input（用户提交角色名 "李云"）
 *   [story]      story-narrator  → LLM 用角色名继续剧情 → narrative.append
 *   [post_story] char-tracker    → LLM 分析叙事识别角色 → record.upsert + state.patch
 *   [post_story] story-guide     → LLM 根据叙事生成选择 → ui.render (choices)
 *
 * Turn 3: user.input（用户选择 "调查暗巷"）
 *   [story]      story-narrator  → LLM 继续剧情 → narrative.append
 *   [post_story] char-tracker    → LLM 识别新 NPC → record.upsert
 *   [post_story] story-guide     → LLM 生成新选择 → ui.render
 *
 * 关键设计：
 * - init-wizard / char-tracker / story-guide 都走 LLM，不是硬编码
 * - LLM 根据剧情上下文动态决定表单内容、角色列表、选择项
 * - 每个 runtime 有自己的 handler，负责解析 LLM 结构化输出 → proposals
 */

import { describe, it, expect } from "vitest";
import { createPluginHost } from "@covel/plugin-runtime";
import type { RuntimeHandlerContext } from "@covel/plugin-runtime";
import { createKernel } from "../src/kernel.js";
import type { GatewayLike } from "@covel/runtime";
import type { KernelInput } from "@covel/shared";

// ════════════════════════════════════════════════════════════════════
// 世界观数据
// ════════════════════════════════════════════════════════════════════

const WORLD = {
  name: "雾港纪事",
  description:
    "一座被永不散去的浓雾笼罩的港口城市。盐雾、机械、帮派与危险航道交织。" +
    "玩家扮演一个刚刚抵达雾港的外来者，卷入了一场关于失踪灯塔守护者的谜案。",
};

// ════════════════════════════════════════════════════════════════════
// Stub LLM Gateway — 模拟不同 runtime 的 LLM 调用
// 在真实场景中，这些都是真实 LLM 返回的结构化输出
// ════════════════════════════════════════════════════════════════════

function createStoryGateway(): GatewayLike {
  return {
    async generateText(input) {
      const systemPrompt = input.messages?.[0]?.content ?? "";
      const lastUserMsg =
        input.messages?.filter((m) => m.role === "user").pop()?.content ?? "";

      // ── story-narrator: 主叙事 ────────────────────────────────
      // (无特殊 system prompt 前缀，默认走这里)
      if (!systemPrompt.includes("[PLUGIN:")) {
        if (!lastUserMsg) {
          // Turn 1: 开局
          return {
            text:
              "雾港，一座建在悬崖与海峡之间的老城。三百年来，灯塔从未熄灭——" +
              "直到上周。守护者沈老失踪了，港口陷入混乱。\n\n" +
              "你拖着行李走下跳板，一个穿着油污围裙的中年男子拦住了你。" +
              "「外来人？」赵铁匠上下打量你。",
            finishReason: "stop",
            usage: { inputTokens: 200, outputTokens: 150 },
          };
        }
        if (lastUserMsg.includes("李云")) {
          // Turn 2: 输入名字后
          return {
            text:
              "赵铁匠点了点头：「李云？」他压低声音，" +
              "「沈老失踪后雾越来越浓。昨晚有人在暗巷看到了影子。」" +
              "他指向码头尽头一条漆黑的小巷。",
            finishReason: "stop",
            usage: { inputTokens: 300, outputTokens: 180 },
          };
        }
        // Turn 3: 选择后
        return {
          text:
            "你转身走入暗巷。雾在这里更加浓密。巷子深处，一扇半掩的木门透出灯光。" +
            "你推开门——一个头发花白的妇人正在整理航海图。" +
            "王寡妇抬头看你：「你是谁？」桌上散落着沈老的笔记。",
          finishReason: "stop",
          usage: { inputTokens: 350, outputTokens: 200 },
        };
      }

      // ── init-wizard: LLM 根据剧情生成角色创建表单 ──────────────
      if (systemPrompt.includes("[PLUGIN:init-wizard]")) {
        // LLM 结合开场叙事生成动态表单内容
        return {
          text: JSON.stringify({
            type: "character-creation",
            content: {
              narrative: "赵铁匠盯着你：「你叫什么名字？码头不欢迎没名字的人。」",
              fields: [
                { key: "name", label: "你的名字", type: "text", required: true },
                {
                  key: "origin",
                  label: "你的来历",
                  type: "select",
                  options: ["流浪旅人", "退役水手", "逃亡学者"],
                },
              ],
            },
          }),
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 80 },
        };
      }

      // ── char-tracker: LLM 分析叙事中出现的角色 ─────────────────
      if (systemPrompt.includes("[PLUGIN:char-tracker]")) {
        const narrative =
          input.messages?.find((m) => m.role === "assistant")?.content ?? "";

        // LLM 返回识别到的角色列表
        const characters: Array<{ name: string; role: string; description: string }> = [];

        if (narrative.includes("赵铁匠"))
          characters.push({ name: "赵铁匠", role: "npc", description: "码头管事，穿着油污围裙" });
        if (narrative.includes("沈老"))
          characters.push({ name: "沈老", role: "npc_missing", description: "失踪的灯塔守护者" });
        if (narrative.includes("李云"))
          characters.push({ name: "李云", role: "protagonist", description: "初到雾港的外来者" });
        if (narrative.includes("王寡妇"))
          characters.push({ name: "王寡妇", role: "npc", description: "整理航海图的花白妇人" });

        return {
          text: JSON.stringify({ characters }),
          finishReason: "stop",
          usage: { inputTokens: 150, outputTokens: 100 },
        };
      }

      // ── story-guide: LLM 根据叙事生成选择 ─────────────────────
      if (systemPrompt.includes("[PLUGIN:story-guide]")) {
        const narrative =
          input.messages?.find((m) => m.role === "assistant")?.content ?? "";

        if (narrative.includes("暗巷") && !narrative.includes("王寡妇")) {
          return {
            text: JSON.stringify({
              title: "赵铁匠给了你三条线索，接下来……",
              options: [
                { id: "alley", label: "调查暗巷", hint: "冒险倾向：直面危险" },
                { id: "lighthouse", label: "前往灯塔遗址", hint: "探索倾向：追踪线索" },
                { id: "wang", label: "找王寡妇打听", hint: "社交倾向：收集情报" },
              ],
            }),
            finishReason: "stop",
            usage: { inputTokens: 120, outputTokens: 90 },
          };
        }

        return {
          text: JSON.stringify({
            title: "王寡妇盯着你，你如何回应？",
            options: [
              { id: "honest", label: "如实说明来意", hint: "诚实倾向：建立信任" },
              { id: "lie", label: "编造一个身份", hint: "狡诈倾向：隐藏目的" },
              { id: "symbol", label: "直接询问符号", hint: "直觉倾向：抓住关键" },
            ],
          }),
          finishReason: "stop",
          usage: { inputTokens: 120, outputTokens: 90 },
        };
      }

      // Fallback
      return {
        text: "...",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },

    async *streamText(input) {
      // The narrator runtime (no handler, no tools) uses the streaming path.
      // Replicate the generateText narrator logic for streamText.
      const lastUserMsg =
        input.messages?.filter((m: any) => m.role === "user").pop()?.content ?? "";

      let text: string;
      let usage = { inputTokens: 200, outputTokens: 150 };

      if (!lastUserMsg) {
        // Turn 1: 开局
        text =
          "雾港，一座建在悬崖与海峡之间的老城。三百年来，灯塔从未熄灭——" +
          "直到上周。守护者沈老失踪了，港口陷入混乱。\n\n" +
          "你拖着行李走下跳板，一个穿着油污围裙的中年男子拦住了你。" +
          "「外来人？」赵铁匠上下打量你。";
      } else if (lastUserMsg.includes("李云")) {
        // Turn 2: 输入名字后
        text =
          "赵铁匠点了点头：「李云？」他压低声音，" +
          "「沈老失踪后雾越来越浓。昨晚有人在暗巷看到了影子。」" +
          "他指向码头尽头一条漆黑的小巷。";
        usage = { inputTokens: 300, outputTokens: 180 };
      } else {
        // Turn 3: 选择后
        text =
          "你转身走入暗巷。雾在这里更加浓密。巷子深处，一扇半掩的木门透出灯光。" +
          "你推开门——一个头发花白的妇人正在整理航海图。" +
          "王寡妇抬头看你：「你是谁？」桌上散落着沈老的笔记。";
        usage = { inputTokens: 350, outputTokens: 200 };
      }

      yield { type: "text-delta" as const, textDelta: text };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage,
      };
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 注册插件 & 内核
// ════════════════════════════════════════════════════════════════════

function setupGameSession() {
  const host = createPluginHost();

  // 用于跟踪 char-tracker 的角色数据库
  const characterDb = new Map<
    string,
    { name: string; role: string; description: string; firstSeenTurn: string }
  >();

  // ── 插件 1: story-narrator (主叙事 LLM, story phase, always) ───
  host.pluginRegistry.add(
    {
      schemaVersion: "1.0",
      id: "story-narrator",
      displayName: "主叙事",
      version: "0.1.0",
      author: "covel",
      description: "主叙事 LLM 运行时",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
    },
    "/virtual/story-narrator"
  );
  host.runtimeRegistry.register("story-narrator", {
    id: "narrator",
    pluginId: "story-narrator",
    kind: "story",
    phase: "story",
    priority: 400,
    trigger: { mode: "always" },
    providerBinding: "default",
    tools: [],
    hooks: [],
  });
  // 无 handler → 走 LLM gateway → 结果作为 narrative.append

  // ── 插件 2: init-wizard (角色创建, session_start 时触发) ────────
  host.pluginRegistry.add(
    {
      schemaVersion: "1.0",
      id: "init-wizard",
      displayName: "初始化向导",
      version: "0.1.0",
      author: "covel",
      description: "角色创建初始化",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
    },
    "/virtual/init-wizard"
  );
  host.runtimeRegistry.register("init-wizard", {
    id: "init",
    pluginId: "init-wizard",
    kind: "plugin",
    phase: "post_story",
    priority: 450,
    trigger: { mode: "event", onEvents: ["session_start"] },
    tools: [],
    hooks: [],
  });
  // handler: 调用 LLM 生成表单，解析结构化输出 → ui.render proposal
  host.runtimeRegistry.setHandler("init-wizard", "init", async (ctx) => {
    // 把 PLUGIN.md instructions 注入 system prompt
    const context = ctx.context as any;
    const gateway = (ctx as any)._gateway; // 通过下面的 wrapper 注入

    // 构造 LLM 调用 — 在真实实现中这会走 executor
    // 测试中直接调用 gateway
    const narrative = context.narrative?.content ?? "";
    const result = await gateway.generateText({
      messages: [
        { role: "system", content: "[PLUGIN:init-wizard] 根据当前叙事为玩家生成一个角色创建表单。输出 JSON。" },
        { role: "assistant", content: narrative },
      ],
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        proposals: [{ kind: "ui.render", payload: parsed }],
      };
    } catch {
      return { proposals: [] };
    }
  });

  // ── 插件 3: char-tracker (角色识别, user.input 时触发) ──────────
  host.pluginRegistry.add(
    {
      schemaVersion: "1.0",
      id: "char-tracker",
      displayName: "角色追踪",
      version: "0.1.0",
      author: "covel",
      description: "识别并记录叙事中出现的角色",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
    },
    "/virtual/char-tracker"
  );
  host.runtimeRegistry.register("char-tracker", {
    id: "tracker",
    pluginId: "char-tracker",
    kind: "plugin",
    phase: "post_story",
    priority: 600,
    trigger: { mode: "event", onEvents: ["user.input"] },
    tools: [],
    hooks: [],
  });
  host.runtimeRegistry.setHandler("char-tracker", "tracker", async (ctx) => {
    const context = ctx.context as any;
    const gateway = (ctx as any)._gateway;
    const narrative = context.narrative?.content ?? "";
    const turnId = context.run?.turnId ?? "unknown";

    // LLM 分析叙事中的角色
    const result = await gateway.generateText({
      messages: [
        { role: "system", content: "[PLUGIN:char-tracker] 分析以下叙事文本，识别其中出现的所有角色。输出 JSON: {characters: [{name, role, description}]}" },
        { role: "assistant", content: narrative },
      ],
    });

    const proposals: Array<{ kind: string; payload: unknown }> = [];

    try {
      const parsed = JSON.parse(result.text);
      const newCharacters: string[] = [];

      for (const char of parsed.characters ?? []) {
        if (!characterDb.has(char.name)) {
          characterDb.set(char.name, { ...char, firstSeenTurn: turnId });
          newCharacters.push(char.name);

          proposals.push({
            kind: "record.upsert",
            payload: {
              key: `character:${char.name}`,
              value: { ...char, firstSeenTurn: turnId },
            },
          });
        }
      }

      if (newCharacters.length > 0) {
        proposals.push({
          kind: "state.patch",
          payload: {
            knownCharacterCount: characterDb.size,
            lastDiscoveredCharacters: newCharacters,
          },
        });
      }
    } catch {
      // LLM 返回非 JSON，跳过
    }

    return { proposals };
  });

  // ── 插件 4: story-guide (剧情指导, user.input 时触发) ──────────
  host.pluginRegistry.add(
    {
      schemaVersion: "1.0",
      id: "story-guide",
      displayName: "剧情指导",
      version: "0.1.0",
      author: "covel",
      description: "为玩家提供下一步选择",
      defaultLocale: "zh-CN",
      supportedLocales: ["zh-CN"],
      requires: ["char-tracker"], // 依赖 char-tracker → 保证拓扑顺序
    },
    "/virtual/story-guide"
  );
  host.runtimeRegistry.register("story-guide", {
    id: "guide",
    pluginId: "story-guide",
    kind: "plugin",
    phase: "post_story",
    priority: 600,
    trigger: { mode: "event", onEvents: ["user.input"] },
    tools: [],
    hooks: [],
  });
  host.runtimeRegistry.setHandler("story-guide", "guide", async (ctx) => {
    const context = ctx.context as any;
    const gateway = (ctx as any)._gateway;
    const narrative = context.narrative?.content ?? "";

    // LLM 根据叙事生成选择
    const result = await gateway.generateText({
      messages: [
        { role: "system", content: "[PLUGIN:story-guide] 根据当前叙事为玩家生成 2-3 个不同倾向的选择。输出 JSON: {title, options: [{id, label, hint}]}" },
        { role: "assistant", content: narrative },
      ],
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        proposals: [
          { kind: "ui.render", payload: { type: "choices", content: parsed } },
        ],
      };
    } catch {
      return { proposals: [] };
    }
  });

  // ── 创建内核 ───────────────────────────────────────────────────
  const gateway = createStoryGateway();

  // Wrap runtime handlers to inject gateway reference
  // (在真实实现中，handler 通过 executor 访问 gateway)
  const originalRuntime = host.runtimeRegistry;
  for (const rt of originalRuntime.listAll()) {
    if (rt.handler) {
      const originalHandler = rt.handler;
      rt.handler = async (ctx: RuntimeHandlerContext) => {
        (ctx as any)._gateway = gateway;
        return originalHandler(ctx);
      };
    }
  }

  const kernel = createKernel({ pluginHost: host, gateway });

  kernel.setContext({
    world: WORLD,
    state: {},
  });

  return { kernel, host, characterDb, gateway };
}

// ════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════

describe("完整游戏流程", () => {
  it("三个 Turn 的完整闭环", async () => {
    const { kernel, characterDb } = setupGameSession();

    // ── Turn 1: 开始游戏 (session_start) ─────────────────────────
    const turn1 = await kernel.executeTurn({
      runId: "run-001",
      branchId: "branch-main",
      actorId: "player-1",
      type: "session_start",
      locale: "zh-CN",
      payload: {},
    });

    // 有叙事输出（背景故事）
    const narrative1 = turn1.render.blocks.find((b) => b.type === "narrative");
    expect(narrative1).toBeDefined();
    expect(narrative1!.content).toContain("雾港");
    expect(narrative1!.content).toContain("赵铁匠");

    // 有角色创建 UI（init-wizard 触发）
    const initBlock = turn1.render.blocks.find(
      (b) => b.type === "character-creation"
    );
    expect(initBlock).toBeDefined();
    const initContent = initBlock!.content as any;
    expect(initContent.narrative).toContain("名字"); // LLM 生成的动态叙事
    expect(initContent.fields.length).toBeGreaterThan(0);

    // 没有 choices（story-guide 不应触发）
    const choices1 = turn1.render.blocks.filter(
      (b) => b.type === "choices"
    );
    expect(choices1).toHaveLength(0);

    // 角色数据库空（char-tracker 不应触发）
    expect(characterDb.size).toBe(0);

    console.log("\n=== Turn 1: 开始游戏 ===");
    console.log("叙事:", (narrative1!.content as string).slice(0, 60) + "...");
    console.log("UI: 角色创建表单 —", initContent.narrative);

    // ── Turn 2: 用户提交角色名 ───────────────────────────────────
    kernel.setContext({
      chat: [{ role: "user", content: "我叫李云，是个流浪旅人" }],
    });

    const turn2 = await kernel.executeTurn({
      runId: "run-001",
      branchId: "branch-main",
      actorId: "player-1",
      type: "user.input",
      locale: "zh-CN",
      payload: { text: "我叫李云，是个流浪旅人" },
    });

    // 叙事继续
    const narrative2 = turn2.render.blocks.find((b) => b.type === "narrative");
    expect(narrative2).toBeDefined();
    expect(narrative2!.content).toContain("李云");

    // char-tracker 识别了角色
    expect(characterDb.size).toBeGreaterThan(0);
    expect(characterDb.has("李云")).toBe(true);
    expect(characterDb.has("赵铁匠")).toBe(true);
    expect(characterDb.get("李云")!.role).toBe("protagonist");

    // 有 record.upsert proposals
    const recordProposals = turn2.proposals.flatMap((e) =>
      e.items.filter((i) => i.kind === "record.upsert")
    );
    expect(recordProposals.length).toBeGreaterThan(0);

    // story-guide 生成了选择
    const choicesBlock2 = turn2.render.blocks.find(
      (b) => b.type === "choices"
    );
    expect(choicesBlock2).toBeDefined();
    const choices2 = choicesBlock2!.content as any;
    expect(choices2.options.length).toBeGreaterThanOrEqual(2);
    expect(choices2.options.some((o: any) => o.id === "alley")).toBe(true);

    // init-wizard 不应触发
    expect(
      turn2.proposals.find((e) => e.pluginId === "init-wizard")
    ).toBeUndefined();

    // char-tracker 在 story-guide 之前（拓扑排序）
    const trackerIdx = turn2.proposals.findIndex(
      (e) => e.pluginId === "char-tracker"
    );
    const guideIdx = turn2.proposals.findIndex(
      (e) => e.pluginId === "story-guide"
    );
    expect(trackerIdx).toBeLessThan(guideIdx);

    console.log("\n=== Turn 2: 用户输入名字 ===");
    console.log("叙事:", (narrative2!.content as string).slice(0, 60) + "...");
    console.log("新角色:", Array.from(characterDb.keys()).join(", "));
    console.log(
      "选择:",
      choices2.options.map((o: any) => `${o.label}(${o.hint})`).join(" | ")
    );

    // ── Turn 3: 用户选择 "调查暗巷" ─────────────────────────────
    kernel.setContext({
      chat: [
        { role: "user", content: "我叫李云，是个流浪旅人" },
        { role: "assistant", content: (narrative2!.content as string).slice(0, 200) },
        { role: "user", content: "我决定调查暗巷" },
      ],
    });

    const turn3 = await kernel.executeTurn({
      runId: "run-001",
      branchId: "branch-main",
      actorId: "player-1",
      type: "user.input",
      locale: "zh-CN",
      payload: { text: "我决定调查暗巷", choiceId: "alley" },
    });

    // 叙事继续
    const narrative3 = turn3.render.blocks.find((b) => b.type === "narrative");
    expect(narrative3).toBeDefined();
    expect(narrative3!.content).toContain("暗巷");
    expect(narrative3!.content).toContain("王寡妇");

    // char-tracker 识别了新角色
    expect(characterDb.has("王寡妇")).toBe(true);
    expect(characterDb.get("王寡妇")!.role).toBe("npc");

    // story-guide 生成了新选择
    const choicesBlock3 = turn3.render.blocks.find(
      (b) => b.type === "choices"
    );
    expect(choicesBlock3).toBeDefined();
    const choices3 = choicesBlock3!.content as any;
    expect(choices3.options.some((o: any) => o.hint?.includes("诚实"))).toBe(true);
    expect(choices3.options.some((o: any) => o.hint?.includes("狡诈"))).toBe(true);

    console.log("\n=== Turn 3: 调查暗巷 ===");
    console.log("叙事:", (narrative3!.content as string).slice(0, 60) + "...");
    console.log("全部角色:", Array.from(characterDb.keys()).join(", "));
    console.log(
      "新选择:",
      choices3.options.map((o: any) => `${o.label}(${o.hint})`).join(" | ")
    );

    // ── 最终验证 ─────────────────────────────────────────────────
    expect(characterDb.size).toBe(4); // 李云、赵铁匠、沈老、王寡妇
    expect(turn1.commit).toBeDefined();
    expect(turn2.commit).toBeDefined();
    expect(turn3.commit).toBeDefined();

    console.log("\n=== 最终状态 ===");
    console.log("角色数据库:", JSON.stringify(Object.fromEntries(characterDb), null, 2));
  });

  it("Turn 1: init-wizard 触发而 guide/tracker 不触发", async () => {
    const { kernel, characterDb } = setupGameSession();

    const result = await kernel.executeTurn({
      runId: "run-002",
      branchId: "branch-main",
      actorId: "player-1",
      type: "session_start",
      locale: "zh-CN",
      payload: {},
    });

    // init-wizard 应该触发
    const initProposal = result.proposals.find(
      (e) => e.pluginId === "init-wizard"
    );
    expect(initProposal).toBeDefined();
    expect(initProposal!.items.some((i) => i.kind === "ui.render")).toBe(true);

    // char-tracker 和 story-guide 不应触发
    expect(
      result.proposals.find((e) => e.pluginId === "char-tracker")
    ).toBeUndefined();
    expect(
      result.proposals.find((e) => e.pluginId === "story-guide")
    ).toBeUndefined();
    expect(characterDb.size).toBe(0);
  });

  it("char-tracker 在 story-guide 之前执行 (拓扑排序保证)", async () => {
    const { kernel } = setupGameSession();

    // 先 session_start
    await kernel.executeTurn({
      runId: "run-003",
      branchId: "branch-main",
      actorId: "player-1",
      type: "session_start",
      locale: "zh-CN",
      payload: {},
    });

    // 然后 user.input
    kernel.setContext({
      chat: [{ role: "user", content: "我叫李云" }],
    });

    const result = await kernel.executeTurn({
      runId: "run-003",
      branchId: "branch-main",
      actorId: "player-1",
      type: "user.input",
      locale: "zh-CN",
      payload: { text: "我叫李云" },
    });

    const trackerIdx = result.proposals.findIndex(
      (e) => e.pluginId === "char-tracker"
    );
    const guideIdx = result.proposals.findIndex(
      (e) => e.pluginId === "story-guide"
    );

    expect(trackerIdx).toBeGreaterThanOrEqual(0);
    expect(guideIdx).toBeGreaterThanOrEqual(0);
    expect(trackerIdx).toBeLessThan(guideIdx);
  });

  it("Proposal 类型全覆盖: narrative + record + state + ui.render", async () => {
    const { kernel } = setupGameSession();

    await kernel.executeTurn({
      runId: "run-004",
      branchId: "branch-main",
      actorId: "player-1",
      type: "session_start",
      locale: "zh-CN",
      payload: {},
    });

    kernel.setContext({
      chat: [{ role: "user", content: "我叫李云" }],
    });

    const result = await kernel.executeTurn({
      runId: "run-004",
      branchId: "branch-main",
      actorId: "player-1",
      type: "user.input",
      locale: "zh-CN",
      payload: { text: "我叫李云" },
    });

    const allKinds = new Set(
      result.proposals.flatMap((e) => e.items.map((i) => i.kind))
    );

    expect(allKinds.has("narrative.append")).toBe(true);
    expect(allKinds.has("record.upsert")).toBe(true);
    expect(allKinds.has("state.patch")).toBe(true);
    expect(allKinds.has("ui.render")).toBe(true);
  });
});
