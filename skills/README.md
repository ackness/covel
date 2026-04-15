# Covel Skills

可被外部 IDE 代理(Claude Code、Codex 等)按需加载的"技能"目录。

每个子目录是一个独立 skill,遵循 [agentskills.io](https://agentskills.io) 规范:

```
skills/<skill-name>/
├── SKILL.md           # 入口文档,带 YAML frontmatter (name + description)
└── references/        # 可选,SKILL.md 按需加载的更详细参考
```

## 当前 skills

| skill | 目的 | 触发场景 |
|------|------|---------|
| [create-world](./create-world/SKILL.md) | 创建 Covel 世界包 (`worlds/<id>/world.yaml` + `WORLD.md`) | 用户想新建一个游戏世界 |
| [create-plugin](./create-plugin/SKILL.md) | 创建 Covel 插件包 (`plugins/<id>/PLUGIN.md` + 工具/UI) | 用户想新建一个插件 |
| [plugin-authoring](./plugin-authoring/SKILL.md) | 插件作者参考(field 速查、示例) | 编写或重构插件 |
| [world-authoring](./world-authoring/SKILL.md) | 世界包深度参考(dim schema、示例) | 编辑现有 world 或扩展维度 |
| [world-extract](./world-extract/SKILL.md) | 从已有 lore 中抽取结构化 dim | 给老 world 补 dimensions |

## skills vs framework code

skills 是**纯文档**,Covel server 既不发现也不加载 skills 目录,这里没有 SkillRegistry。skills 的消费方是外部代理(Claude Code 通过 `.claude/skills/` 自动发现,Codex 通过文件读取)。

如果一个能力需要在运行时被框架本身使用(比如 `create-character` 工具),它应该作为 builtin tool 或 plugin 实现,而不是 skill。

## 与 .claude/skills/ 的关系

`.claude/skills/<name>/` 是 Claude Code 的 session 级 skill 发现路径(IDE 本地)。`skills/<name>/` 是项目级公共版本(可移植到任何 IDE 或代理)。两者保持内容同步;`.claude/skills/<name>/` 可以是软链接也可以是普通副本。

## 添加新 skill

参考 [docs/guide/skills.md](../docs/guide/skills.md) 的步骤说明。
