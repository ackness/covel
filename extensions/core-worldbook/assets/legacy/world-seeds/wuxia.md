---
id: legacy-wuxia-nine-provinces
genre: wuxia
tags: [武侠, 古风, 江湖, 中国风]
defaultLocale: zh-CN
metadataLocales: [zh-CN, en]
contentLocales: [zh-CN]
sourceProject: ../ai-gamestudio-dev
sourcePath: templates/worlds/wuxia.md
legacyCapabilityHints: [skill-check, combat, inventory, quest, faction, relationship, status-effect, codex]
localizedMetadata:
  zh-CN:
    name: 九州江湖录
    description: 大梁末年，江湖风云再起。天机卷重现武林，正邪六门蠢蠢欲动。
  en:
    name: Chronicle of the Nine Provinces
    description: Rival sects fight over the Heavenly Mechanism Scroll as the martial world descends into chaos.
ingestionHints:
  artifactKind: world-doc
  memorySourceType: worldbook
  preferredScope: world-template
---

# 九州江湖录

## 世界背景

大梁王朝末年，朝廷衰弱，江湖势力趁势崛起。三大正派与三大魔门维持百年脆弱平衡，而失传已久的《天机卷》突然重现，令各方势力重新洗牌。

## 地理与势力

### 九州大地

- 中原：王朝腹地与正派中心。
- 江南：商贾云集，药王谷隐于烟雨之间。
- 西域：异族杂居，传说古刹藏有秘闻。
- 北疆：苦寒边地，铁骑帮势大。
- 南疆：毒瘴密林，蛊术盛行。
- 东海：海盗与仙山传说并存。

### 正邪六门

- 天剑门：剑法刚猛，重名节。
- 药王谷：医毒双绝，擅暗器。
- 少林寺：拳法、内功与禅学并重。
- 万毒门：蛊毒奇诡，作风难测。
- 血刀堂：擅暗杀、情报与易容。
- 幽冥教：修邪功，传言可控魂御尸。

## 力量体系

- 内力是武学根基，境界可分为入门、小成、大成、宗师、天人。
- 武功分外功、内功、轻功、暗器与奇门。
- 江湖秩序围绕门规、恩怨与比武规则维持。

## 核心冲突

- 天机卷之争：残卷与秘境线索推动主线。
- 朝廷与江湖：锦衣卫试图渗透并控制武林。
- 正邪大战：表面阵营对立，内部也各怀算计。
- 身世之谜：主角体内异种内力可能与天机卷有关。

## DM 指引

### 叙事风格

- 强调武侠意境、恩怨与人情。
- 战斗描写要体现招式名称、内力运转与兵器碰撞。
- 允许适度古风用语，但避免晦涩。

### 运行时拆分建议

- 世界规则、门派与地点：归入 `worldbook`
- 叙事语气与主持方式：后续可拆到 `persona`
- NPC 属性、物品、关系：适合未来 `character-card` / `memory document`
- 当前 staged asset 只有 `zh-CN` 正文；若 UI 或命令以 `en` 查看，应显式保留 `contentLocale: zh-CN`

## 重要 NPC 种子

- 王二：消息灵通的客栈掌柜。
- 独臂翁：隐退宗师，可提供关键指引。
- 红衣：追查天机卷的神秘女子。
- 小青：药王谷弟子，能引出支线。
