# 世界包验证指引

世界包没有可执行代码,验证主要是 **schema 校验** + **跨字段引用一致性** + **lore 完整度**。三层,按需做。

| 层 | 检查什么 | 怎么跑 | 必做? |
|---|---|---|---|
| **L1 Schema** | `validateWorldManifest`(Zod strict) | 一行 node 命令 | ✓ 必须 |
| **L2 引用一致性** | faction.relations.targetId 指向的 id 真实存在 | 一行 node 脚本 | 当 factions 含 relations 时必须 |
| **L3 内容完整度** | WORLD.md 是否引用了 yaml 里的关键 region/faction/事件 | 人工肉眼或 grep | 准备发布时建议 |

---

## L1 — Schema 校验(必做)

```bash
node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { validateWorldManifest, formatValidationErrors } from '@covel/shared';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const r = validateWorldManifest(y);
if(!r.valid){console.error(formatValidationErrors(r.errors));process.exit(1)}
console.log('schema OK');
"
```

仓库外世界(`~/.covel/worlds/<id>/`)同样脚本,但要在 `packages/plugin-loader/`(或任何已经 link 了 `@covel/shared` + `yaml` 的子目录) 下执行。

---

## L2 — 引用一致性(有 relations 就跑)

如果 `dimensions.factions[].relations[]` 用到了 `targetId`,必须确保它指向真实存在的 faction id,否则世界初始化时图就断了。

```bash
node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const ids = new Set((y.dimensions?.factions ?? []).map(f => f.id));
const broken = [];
for (const f of y.dimensions?.factions ?? []) {
  for (const r of f.relations ?? []) {
    if (!ids.has(r.targetId)) broken.push(\`\${f.id} → \${r.targetId}\`);
  }
}
if (broken.length){
  console.error('Dangling faction relations:', broken);
  process.exit(1);
}
console.log('refs OK');
"
```

> 同样的检查思路适用于:`history[].era`、`socialStructure.classes[].rank` 之间是否单调,等等。但只有 `faction.relations.targetId` 是真正会被框架消费的硬引用。

---

## L3 — Lore 完整度(可选)

`WORLD.md` 是给主叙事插件 (`narrator`) 当世界书塞进 prompt 的;`world.yaml` 是给所有插件 (`codex` / `npc-graph` / `world-init` 等) 结构化消费的。两者**应该**互相覆盖以下"关键名词":

- 所有 `dimensions.geography.regions[].name`
- `dimensions.factions[].name`(至少 major)
- `dimensions.powerSystem.tiers[].name`
- 至少 1 条 major `history[]`
- `startingConditions.openingScenario` 提到的 NPC、地点、物品

简单 grep 即可:

```bash
node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const lore = readFileSync('worlds/<id>/WORLD.md','utf-8');
const i18n = (v) => typeof v === 'string' ? v : (v?.['zh-CN'] ?? Object.values(v ?? {})[0] ?? '');
const names = [
  ...(y.dimensions?.geography?.regions ?? []).map(r => i18n(r.name)),
  ...(y.dimensions?.factions ?? []).filter(f => f.influence === 'major').map(f => i18n(f.name)),
];
const missing = names.filter(n => n && !lore.includes(n));
if (missing.length){
  console.warn('WORLD.md 缺少这些关键名词的描述:', missing);
} else {
  console.log('lore coverage OK');
}
"
```

只是 warning, 不强制 exit 1 —— 世界作者可以选择性地在 lore 里聚焦某些区域,不必把 yaml 里所有名词都写进去。

---

## L4 — 真实游戏验证(发布前可选)

把世界包扔进 `worlds/`,启动 `pnpm dev`,在 UI 选这个世界跑 1-2 个 turn,看:

1. `world-init/schema-gen` 能否正确识别(或填充)世界维度
2. `narrator` 第一回合输出是否贴合 `openingScenario`
3. `/debug` 页面 → Prompt Viewer 检查 `world.lore` 段是否完整
4. 是否有 `requiredPlugins` 缺失警告

不需要写测试代码,纯人工验证。

---

## 决策树

```
写完 world.yaml + WORLD.md
└─ L1 schema 校验(必做)
   ├─ factions 有 relations? → L2 引用检查
   └─ 准备发布?
      ├─ 是 → L3 lore 覆盖度 grep + L4 真实游戏跑一回合
      └─ 否(本地测试用) → 跳过 L3/L4
```
