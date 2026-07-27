---
name: create-world
description: 创建 Covel 世界包。根据用户概念直接生成 world.yaml + WORLD.md 写入 worlds/ 目录并验证。当用户想创建新世界、新地图、新世界观设定、或者说"帮我搞一个 XX 风格的世界"时使用。
---

# 创建 Covel 世界

根据用户的世界观概念，直接生成完整的世界包文件并写入 `worlds/` 目录。

## 流程

### 1. 理解概念

用户给出概念后，如果足够清晰就直接开始。如果模糊，最多追问 1-2 个问题（不要追问技术参数——id、tags 等由你自主决定）：

- 核心冲突是什么？
- 力量体系偏哪种？

### 2. 生成文件

```
worlds/<id>/
├── world.yaml          # 必需，世界 manifest（Zod strict，拒绝未定义字段）
├── WORLD.md            # 必需，默认 lore 文档（800-1500 字）
├── WORLD.<lang>.md     # 可选，仅在真的要提供第二语种时补
└── data/
    ├── world.data.yaml # worldData descriptor（推荐）
    └── dimensions.yaml # 外置维度（两个内置世界的做法）
```

lore 解析链是 **`WORLD.<lang>.md` → `WORLD.md` → 空字符串**。`WORLD.md` 是所有 locale 的兜底，必须写；写了 `WORLD.zh.md` 却没有 `WORLD.md`，非 zh 的会话拿到的就是空 lore。`pnpm release:preflight` 会检查每个世界都有 `world.yaml` + 至少一个 `WORLD*.md`。

**维度写在哪** —— 三选一，越往下越适合大世界：

1. 内联 `world.yaml` 的 `dimensions:` —— 小世界最省事
2. `dimensionSources:` 按维度键指向外部文件
3. `worldData` descriptor 里一条 `to: world:metadata.dimensions` 的 source —— **`worlds/mistport` 和 `worlds/haruka-academy` 都是这种**，维度全写在 `data/dimensions.yaml`

创作要求：

- 至少 3 个地区、3 个阵营、4 个力量等级、3 个历史事件、3 个社会阶层
- `openingScenario` 必须呈现即时的选择或紧张感
- 按玩法选 `pluginPolicy.preset`：传统叙事 `traditional-story`，对话/校园/群像 `dialogue-mode`，省 token `low-cost`
- **视觉小说世界**（对话模式的增强档）：声明 `defaultViewMode: stage` 进全屏舞台（背景 + 立绘 + 打字机）。资产是**渐进增强**——没有立绘/场景图也能跑（回退世界头图 + 占位卡），后续可用 `scripts/generate-portraits.mjs` / `generate-scenes.mjs` 补。成品参考 `worlds/haruka-academy`
- **写任何插件 ID 之前先 `ls plugins/` 确认它存在**——schema 不校验插件 ID，拼错要拖到建会话时才暴露
- 避免泛化的奇幻套路，追求独特的世界设定
- 所有 ID 字段（world id、faction id、worldData source id）用 kebab-case 英文；其余内容用用户的语言（默认中文）

### 3. 验证

**L1 schema 校验（必做）**，在仓库根目录跑：

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

> 必须用 `tsx`，并且按**相对路径**导入 schema。workspace 包直接导出 TS 源码（`\"import\": \"./src/index.ts\"`），裸 `node` 解析不了；`import '@covel/shared'` 在仓库根目录也解析不到包。

按需追加：

| 你写了什么                 | 至少要跑哪几层                             |
| -------------------------- | ------------------------------------------ |
| 最小 world.yaml + WORLD.md | **L1 schema**（必做）                      |
| 声明了 `worldData`         | + **L1b descriptor 校验**                  |
| factions 含 `relations[]`  | + **L2 引用一致性**                        |
| 准备对外发布               | + **L3 lore 覆盖度** + **L4 真实跑一回合** |

校验失败则修复后重新写入。L1b/L2/L3/L4 的现成脚本见 `references/world-validation.md`（必读）。

### 4. 展示结果

给用户一个简洁摘要：世界名称、地区数、阵营数、力量体系、开场场景、跑了哪几层校验。问是否需要调整。

## References

- 生成 world.yaml 前，读 `references/world-yaml-schema.md`——完整字段结构、枚举值、worldData descriptor
- 需要格式参考时，读 `references/example-world.md`
- 验证阶段读 `references/world-validation.md`——现成的校验脚本

权威文档在 `docs/reference/world-data.md`（worldData / source import / override 的唯一真相源）；本目录的 references 是它的操作向导，冲突时以 docs 为准。
