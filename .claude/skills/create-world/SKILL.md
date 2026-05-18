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

在 `worlds/<id>/` 下生成三个文件：

1. **world.yaml** — 完整的世界 manifest。读取 `references/world-yaml-schema.md` 获取准确的字段结构和约束。schema 使用 strict 模式，不允许未定义字段。0.0.3 起优先声明 `pluginPolicy` 和 `worldData: data/world.data.yaml`，让会话准备页和世界数据导入管线使用结构化信息。
2. **WORLD.md** — 默认 lore 文档（800-1500 字）
3. **WORLD.zh.md**（或对应 locale）— locale 版本的 lore

创作要求：

- 至少 3 个地区、3 个阵营、4 个力量等级、3 个历史事件、3 个社会阶层
- `openingScenario` 必须呈现即时的选择或紧张感
- 按玩法选择 `pluginPolicy.preset`: 传统叙事用 `traditional-story`，对话/校园/群像用 `dialogue-mode`
- 本仓库示例世界默认声明 `worldData: data/world.data.yaml`; 如果生成对应数据 descriptor，必须读取 `references/world-yaml-schema.md` 的 worldData 小节
- 避免泛化的奇幻套路，追求独特的世界设定
- 所有 ID 字段（world id, faction id）使用 kebab-case 英文
- 其余内容使用用户的语言（默认中文）

### 3. 验证（按需分层）

参考 `references/world-validation.md`(必读) — 给出三层校验脚本和决策树。简版决策：

| 你写了什么                 | 至少要跑哪几层                                 |
| -------------------------- | ---------------------------------------------- |
| 最小 world.yaml + WORLD.md | **L1 schema**(必做)                            |
| factions 含 `relations[]`  | + **L2 引用一致性**                            |
| 准备对外发布               | + **L3 lore 覆盖度** + **L4 真实游戏跑一回合** |

L1 一行命令(必做):

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

校验失败则修复后重新写入。L2/L3/L4 见 `references/world-validation.md`。

### 4. 展示结果

给用户一个简洁摘要：世界名称、地区数、阵营数、力量体系、开场场景、跑了哪几层校验。问是否需要调整。

## References

- 生成 world.yaml 前，读取 `references/world-yaml-schema.md` 了解完整字段结构和枚举值
- 需要格式参考时，读取 `references/example-world.md` 查看现有世界的 world.yaml 样例
- 验证阶段（特别是带 relations 或准备发布时），读取 `references/world-validation.md` 拿现成的校验脚本
