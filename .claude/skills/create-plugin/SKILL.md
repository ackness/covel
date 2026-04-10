---
name: create-plugin
description: 创建 Covel 插件。通过对话了解需求，直接生成 PLUGIN.md + package.json 写入 plugins/ 目录并验证。当用户想创建新插件、新游戏机制、新功能模块、或者说"帮我做一个 XX 系统"时触发。
user_invocable: true
---

# 创建 Covel 插件

根据用户需求，直接生成完整的插件文件并写入 `plugins/` 目录。

## 流程

### 1. 理解需求

用户说"做一个物品系统"或"我需要 NPC 对话引擎"。

如果需求清晰就直接开始。如果模糊，最多追问 1-2 个问题（技术参数由你自主推断）：
- 它在叙事之前还是之后执行？
- 需要玩家交互（表单/选择）吗？

### 2. 生成文件

在 `plugins/<id>/` 下创建文件。生成前读取 `references/plugin-schema.md` 确认 frontmatter 字段结构。

#### PLUGIN.md

YAML frontmatter（strict 模式，不允许未定义字段）+ Markdown 正文。

Markdown 正文就是 LLM agent 的 system prompt，结构：

```markdown
# <角色定位，1-2 句>

## 职责
- <具体职责列表>

## 规则
- <行为约束和硬规则>

## 输出格式
<LLM 应该输出什么>

## 示例
<一个具体的输入→输出示例>
```

需要格式参考时，读取 `references/example-plugins.md` 查看现有插件的完整 PLUGIN.md 样例。

#### package.json

```json
{
  "name": "@covel/plugin-<id>",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

#### 自定义工具（如需要）

如果插件需要自定义工具，在 `tools/` 下创建 JS 文件。读取 `references/tool-factory.md` 了解工厂函数模式。

### 3. 验证

写完后运行验证：

```bash
node --input-type=module -e "
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { validatePluginManifest, formatValidationErrors } from '@covel/shared';
const { data } = matter(readFileSync('plugins/<id>/PLUGIN.md','utf-8'));
const r = validatePluginManifest(data);
if(!r.valid){console.error(formatValidationErrors(r.errors));process.exit(1)}
console.log('OK');
"
```

验证失败则修复后重新写入。

### 4. 展示结果

给用户摘要：插件名称、优先级、触发方式、使用的工具。问是否需要调整。

## References

- 生成 PLUGIN.md 前，读取 `references/plugin-schema.md` 了解 frontmatter 字段和枚举值
- 需要格式参考时，读取 `references/example-plugins.md` 查看现有插件样例
- 需要创建自定义工具时，读取 `references/tool-factory.md` 了解工厂函数模式
