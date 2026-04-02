import { describe, it, expect } from "vitest";
import {
  LIVE,
  createLiveGenerateText,
} from "@covel/plugin-test-utils";
import { getCombatSummary, initCombat } from "../server/combat-logic.js";

describe.skipIf(!LIVE)("live: core-combat narration", () => {
  it("generates dramatic combat narration in Chinese", async () => {
    const generateText = await createLiveGenerateText();

    const combat = initCombat(
      [
        { id: "p1", name: "艾伦", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "暗影狼", type: "enemy", hp: 40, maxHp: 40 },
        { id: "e2", name: "狼王", type: "enemy", hp: 80, maxHp: 80 },
      ],
      [18, 12, 15],
      "turn_001"
    );

    const summary = getCombatSummary(combat, "zh-CN");

    const prompt = `你是一个RPG战斗叙述者。以下是当前战斗状态：

${summary}

艾伦攻击了暗影狼，投骰结果为16（成功），造成了13点伤害。暗影狼剩余27 HP。

请用2-3句话生动地叙述这次攻击。要求：
- 使用第二人称"你"
- 描述攻击动作和命中效果
- 不要列举数值，融入叙事中
- 只输出叙事文本`;

    const response = await generateText(prompt);

    expect(response.length).toBeGreaterThan(30);
    expect(response).toMatch(/艾伦|你|暗影狼/);
  }, 60_000);

  it("generates dramatic combat narration in English", async () => {
    const generateText = await createLiveGenerateText();

    const combat = initCombat(
      [
        { id: "p1", name: "Allen", type: "player", hp: 100, maxHp: 100 },
        { id: "e1", name: "Shadow Wolf", type: "enemy", hp: 40, maxHp: 40 },
      ],
      [18, 12],
      "turn_001"
    );

    const summary = getCombatSummary(combat, "en-US");

    const prompt = `You are an RPG combat narrator. Here is the current combat state:

${summary}

Allen attacks the Shadow Wolf. The dice roll result is 16 (success), dealing 13 damage. Shadow Wolf has 27 HP remaining.

Narrate this attack dramatically in 2-3 sentences. Requirements:
- Use second person "you"
- Describe the attack action and impact
- Don't list raw numbers, weave them into the narrative
- Output only the narrative text`;

    const response = await generateText(prompt);

    expect(response.length).toBeGreaterThan(30);
    expect(response).toMatch(/Allen|you|Shadow Wolf|wolf/i);
  }, 60_000);

  it("generates combat end narration", async () => {
    const generateText = await createLiveGenerateText();

    const prompt = `You are an RPG narrator. The player has just won a combat encounter after 4 rounds of battle against a Shadow Wolf and a Wolf King. The player's companion helped in the fight. The Wolf King was the last to fall.

Write a brief victory narration (2-3 sentences) in second person. Be dramatic and satisfying. Output only the narrative text.`;

    const response = await generateText(prompt);

    expect(response.length).toBeGreaterThan(30);
    expect(response).toMatch(/wolf|battle|victory|defeat/i);
  }, 60_000);
});
