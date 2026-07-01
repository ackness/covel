# 归档世界包（Archived World Packages）

这里存放**已从内置样例集中下线**的世界包。它们不再作为开箱即玩的样例维护，但保留完整内容作为参考与可复用模板。

## 为什么归档

Covel 现在只精心维护**两个**互补的旗舰样例世界：

- **`mistport`**（雾港·裂潮纪）—— 传统叙事 / 悬疑探索模式，展示 narrator·codex·npc-graph·memory·living-world-rules。
- **`haruka-academy`**（遥风学园）—— 对话 / GalGame 模式，展示 chat-mode-narrator·scene-cast·scene-prompts·character-blueprint·character-presence。

多个题材相近的故事世界对"展示不同插件能力"没有增量收益，反而增加维护成本与设定漂移风险。因此把下面的世界移到这里：

| 世界        | 题材     | 归档原因                                                                                        |
| ----------- | -------- | ----------------------------------------------------------------------------------------------- |
| `cloudmere` | 修仙     | 与 mistport 同属传统叙事模式；当时 `WORLD.md` 与 `dimensions.yaml` 存在设定不一致（两份草稿）。 |
| `neonridge` | 赛博朋克 | 与 mistport 同属传统叙事模式；`mature` 分级且维度密度偏低。                                     |

## 加载行为

世界加载器（`apps/server/src/world-seed-loader.ts` 的 `loadWorldPackages`）**只扫描 `worlds/` 顶层目录**，且要求目录下直接存在 `world.yaml`。`worlds/_archive/` 下没有 `world.yaml`，加载器对它返回 `null` 并跳过，**不会递归进子目录**——因此本目录里的世界包不会被加载、不会出现在世界选择列表中。

## 如何复活一个归档世界

把目录移回 `worlds/` 顶层即可重新被加载：

```bash
git mv worlds/_archive/cloudmere worlds/cloudmere
```

复活前建议先修复其设定一致性（参考 `mistport` 的 `WORLD.zh.md` ↔ `dimensions.yaml` ↔ `characters/` 三者对齐的方式），并补齐角色卡与 `memoryBlocks`。
