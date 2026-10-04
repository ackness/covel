# 世界包验证指引

世界包没有可执行代码,验证主要是 **schema 校验** + **跨字段引用一致性** + **lore 完整度**。按需做。

| 层 | 检查什么 | 怎么跑 | 必做? |
|---|---|---|---|
| **L1 静态校验** | `world.yaml`(Zod strict)、lore 文件、插件 ID 与契约、worldData descriptor、**每条种子记录**(按接收插件的契约 schema)、各语言变体 | `pnpm validate:world worlds/<id>` | ✓ 必须 |
| **L2 引用一致性** | faction.relations.targetId 指向的 id 真实存在 | 一行 node 脚本 | 当 factions 含 relations 时必须 |
| **L3 内容完整度** | WORLD.md 是否引用了 yaml 里的关键 region/faction/事件 | 人工肉眼或 grep | 准备发布时建议 |

---

## L1 — 静态校验(必做)

在仓库根目录执行:

```bash
pnpm validate:world worlds/<id>
```

它和 `pnpm release:preflight` 用的是同一个校验器,并且复用建会话时的 worldData 预检,所以这里通过的种子,建会话时不会再因为记录内容报错。可以一次传多个目录;仓库外的世界(`~/.covel/worlds/<id>/`)直接传绝对路径。

检查内容:

- `world.yaml` 按生产 schema 校验。
- 每个声明的语言(`defaultLocale` 与 `supportedLocales`)都能解析到 lore 文件;缺 `WORLD.md` 兜底时给 warning。
- `pluginPolicy` 与 `pluginSettings` 里的插件 ID 在已扫描的插件目录中存在;拼写接近已知 ID 时直接判为 error 并给出 "Did you mean"。
- `pluginSettings` 的 key 是该插件声明过的设置项。
- `pluginPolicy.requires` 的契约有提供者。
- descriptor、source 顺序(`after` 指向不存在的 source 会报错)、文件读取。
- 每个 `contract:` source 的每条记录,按接收插件公开的 schema 校验;每个声明的语言各校验一遍,因为不同语言会选到不同的变体文件。
- 语言变体文件与默认文件的 `key` 集合一致,缺记录或多记录给 warning。

选项:

- `--plugins <dir>`:额外扫描一个插件目录(社区插件)。仓库的 `plugins/` 总会扫描。
- `--strict`:没有任何已扫描插件提供的插件 ID / 契约按 error 处理。不加时是 warning,因为提供者可能是没被扫描到的社区插件。

失败输出形如:

```
✗ worlds/<id>/world.yaml
  error   world.yaml · pluginPolicy.requested[1]
          plugin "dice-chek" is not in the scanned plugin directories
          Did you mean "dice-check"?
  error   data/memory-blocks.json · source "memory"
          worldData source "memory" value failed schema validation: data/blocks must be array
```

每条诊断给出文件、位置或 source、问题和可行的修法。按提示改完重跑,直到没有 error。

仍需留意的一点:`to: media` 的 source 要同时写 `key: filename` 和 `indexTo`,否则字节进不了插件索引,舞台拿不到立绘/背景。

---

## L2 — 引用一致性(有 relations 就跑)

如果 `factions` 维度的 `initialValue[].relations[]` 用到了 `targetId`,必须确保它指向真实存在的 faction id。框架不解析这类引用,但叙事会读到这份当前值,悬空 id 会让模型编出不存在的势力。维度可能内联在 `world.yaml`,也可能外置在 `data/dimensions.yaml`,下面的脚本两处都读。

```bash
node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const ext = 'worlds/<id>/data/dimensions.yaml';
const dims = { ...(y.dimensions ?? {}), ...(existsSync(ext) ? parse(readFileSync(ext,'utf-8')) : {}) };
const factions = dims.factions?.initialValue ?? [];
const ids = new Set(factions.map(f => f.id));
const broken = [];
for (const f of factions) {
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

> 同样的检查思路适用于:`history[].era`、`socialStructure.classes[].rank` 之间是否单调,等等。这些都是内容一致性检查;dimension 只按声明的 schema 校验,框架不解析跨项引用。

---

## L3 — Lore 完整度(可选)

`WORLD.md` 是给主叙事插件 (`narrator`) 当世界书塞进 prompt 的;`world.yaml` 是给所有插件 (`codex` / `npc-graph` / `world-init` 等) 结构化消费的。两者**应该**互相覆盖以下"关键名词":

- `geography.initialValue.regions[].name`
- `factions.initialValue[].name`(至少 major)
- `powerSystem.initialValue.tiers[].name`
- 至少 1 条 major `history[]`
- `startingConditions.openingScenario` 提到的 NPC、地点、物品

简单 grep 即可:

```bash
node --input-type=module -e "
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
const y = parse(readFileSync('worlds/<id>/world.yaml','utf-8'));
const ext = 'worlds/<id>/data/dimensions.yaml';
const dims = { ...(y.dimensions ?? {}), ...(existsSync(ext) ? parse(readFileSync(ext,'utf-8')) : {}) };
const lore = readFileSync('worlds/<id>/WORLD.md','utf-8');
const i18n = (v) => typeof v === 'string' ? v : (v?.['zh-CN'] ?? Object.values(v ?? {})[0] ?? '');
const names = [
  ...(dims.geography?.initialValue?.regions ?? []).map(r => i18n(r.name)),
  ...(dims.factions?.initialValue ?? []).filter(f => f.influence === 'major').map(f => i18n(f.name)),
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
4. 是否有 依赖契约未满足的解析诊断

不需要写测试代码,纯人工验证。

---

## 决策树

```
写完 world.yaml + WORLD.md
└─ L1 pnpm validate:world(必做,含 worldData 与种子记录)
   ├─ factions 有 relations? → L2 引用检查
   └─ 准备发布?
      ├─ 是 → L3 lore 覆盖度 grep + L4 真实游戏跑一回合
      └─ 否(本地测试用) → 跳过 L3/L4
```

角色导入还需确认角色类型、字段和 player 单例符合 `characterSchema`；不要以插件私有 namespace 代替角色领域。
