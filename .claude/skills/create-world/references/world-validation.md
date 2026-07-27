# 世界包验证指引

世界包没有可执行代码,验证主要是 **schema 校验** + **跨字段引用一致性** + **lore 完整度**。三层,按需做。

| 层 | 检查什么 | 怎么跑 | 必做? |
|---|---|---|---|
| **L1 Schema** | `worldManifestSchema`(Zod strict) | 一行 tsx 命令 | ✓ 必须 |
| **L1b worldData** | `worldDataDescriptorSchema`(Zod strict) | 一行 tsx 命令 | 声明了 `worldData` 时必须 |
| **L2 引用一致性** | faction.relations.targetId 指向的 id 真实存在 | 一行 node 脚本 | 当 factions 含 relations 时必须 |
| **L3 内容完整度** | WORLD.md 是否引用了 yaml 里的关键 region/faction/事件 | 人工肉眼或 grep | 准备发布时建议 |

> **为什么是 `tsx` 而不是 `node`**：workspace 包直接导出 TS 源码(`"import": "./src/index.ts"`,没有构建产物),裸 `node` 会在 `@covel/shared` 上抛 `ERR_MODULE_NOT_FOUND`。同理别写 `import '@covel/shared'` —— 仓库根目录不依赖它,要按**相对路径**直接导入 schema 文件。只用 `yaml` + `fs` 的脚本(L2/L3)不受影响,纯 `node` 就能跑。

---

## L1 — Schema 校验(必做)

在仓库根目录执行:

```bash
npx tsx -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { worldManifestSchema } from './packages/shared/src/schemas/world.ts';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const r = worldManifestSchema.safeParse(y);
if(!r.success){ for(const i of r.error.issues) console.error(\`  \${i.path.join('.')||'(root)'}: \${i.message}\`); process.exit(1); }
console.log('schema OK');
"
```

失败输出形如:

```
  id: id must be lowercase with hyphens (e.g. "my-world")
  (root): Unrecognized key: "bogusField"
```

仓库外世界(`~/.covel/worlds/<id>/`)用同一条命令,把 `readFileSync` 的路径换成绝对路径即可 —— schema 仍从本仓库相对路径导入。

---

## L1b — worldData descriptor 校验(声明了 worldData 就跑)

`data/world.data.yaml` 走另一套 strict schema,manifest 校验通过**不代表**它合法:

```bash
npx tsx -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { worldDataDescriptorSchema } from './packages/shared/src/schemas/world-data.ts';
const d = parse(readFileSync('worlds/<id>/data/world.data.yaml','utf-8'));
const r = worldDataDescriptorSchema.safeParse(d);
if(!r.success){ for(const i of r.error.issues) console.error(\`  \${i.path.join('.')||'(root)'}: \${i.message}\`); process.exit(1); }
console.log('worldData OK');
"
```

常见失败:

- `schemaVersion` 写成 `"1"`(字符串)—— 必须是数字字面量 `1`
- source id 不符合 `^[a-z][a-zA-Z0-9_-]{0,63}$`(如 `Cast`、`1cast`)
- `to: media` 的 source 忘了写 `indexTo` —— **schema 会放行,但导入是 no-op**:字节进不了插件索引,舞台拿不到立绘/背景。凡是 `kind: media`,检查它有没有配套的 `indexTo`

`after` 引用的 source id 必须在同一份 descriptor 里真实存在,这条 schema 不查,靠肉眼。

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
   ├─ 声明了 worldData? → L1b descriptor 校验
   ├─ factions 有 relations? → L2 引用检查
   └─ 准备发布?
      ├─ 是 → L3 lore 覆盖度 grep + L4 真实游戏跑一回合
      └─ 否(本地测试用) → 跳过 L3/L4
```
