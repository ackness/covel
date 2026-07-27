# Skills 使用与编写指南

Covel 仓库 `.claude/skills/` 目录下的每个子目录都是一个**独立的 skill**，遵循 [agentskills.io](https://agentskills.io) 规范，可以被支持 skill 协议的外部代理（Claude Code、Codex 等）按需加载。

> **重点**：skills 是纯文档资产。Covel server 既不读取也不执行 `.claude/skills/`；它们只对外部 IDE 代理有意义。

## 目录结构

```
.claude/skills/
├── covel-static-turn-audit/
│   ├── SKILL.md
│   └── agents/openai.yaml # 外部代理的展示元信息
├── create-world/
│   ├── SKILL.md           # 入口，YAML frontmatter 必须有 name + description
│   ├── agents/openai.yaml
│   └── references/        # 按需加载的细节参考
│       ├── world-yaml-schema.md
│       └── example-world.md
└── create-plugin/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── references/
```

## SKILL.md 模板

```markdown
---
name: my-skill
description: 一句话描述这个 skill 做什么、何时触发（代理通过 description 决定是否调起）
---

# Skill 标题

## 何时使用

- 列出 1-3 个具体场景

## 输入

- 用户给出的概念、参数或上下文

## 步骤

1. 第一步...
2. 第二步...
3. 第三步...

## 验证

跑某个命令确认产物正确

## References

- 需要 schema 细节时，加载 `references/xxx.md`
- 需要示例时，加载 `references/example-xxx.md`
```

### 关键原则

1. **frontmatter 只写标准字段**。按 Codex skill 规范，`SKILL.md` frontmatter 至少包含 `name` 和 `description`；UI 信息写到 `agents/openai.yaml`。
2. **入口要短**。SKILL.md 控制在 50-150 行，用最少的字让代理知道“这个 skill 是干嘛的、流程是什么”。细节都丢进 `references/`。
3. **References 按需加载**。代理只有真的需要时才会读 references，所以 references 可以写得很详细（几百行没问题）。
4. **frontmatter 的 description 是匹配关键**。description 决定代理是否触发 skill；写得越具体越准，越泛越容易乱跳。
5. **触发场景写进 description**。body 只有触发后才会加载；“何时使用”信息要放在 description 里。

## 在 Claude Code 中使用

Claude Code 启动时扫描以下两个目录的 skills:

1. `~/.claude/skills/<name>/SKILL.md`（全局，跨项目）
2. `<project>/.claude/skills/<name>/SKILL.md`（项目本地）

Covel 已经内置项目本地 skills：

- `.claude/skills/create-plugin/`：生成插件骨架与作者参考。
- `.claude/skills/create-world/`：生成世界包与校验参考。
- `.claude/skills/covel-static-turn-audit/`：静态审计 start-game、插件启用、turn 调度和多轮流程。

## 在外部代理中使用

任何能读 markdown 的代理都可以用 skills:

- **Codex**：直接读 `.claude/skills/<name>/SKILL.md`。
- **OpenAI Assistants / Custom GPTs**：把 SKILL.md 作为 system context 喂进去。
- **VS Code Copilot Workspace** 等：把 `.claude/skills/` 加入工作区。
- **裸 LLM API 调用**：在 system prompt 里加入 `cat .claude/skills/<name>/SKILL.md` 的内容。

## 添加新 skill 的流程

1. 在 `.claude/skills/<your-skill>/` 下建 `SKILL.md`（参考上面模板）。
2. 如果有详细参考，放到 `.claude/skills/<your-skill>/references/`。
3. 新增 `agents/openai.yaml`，至少提供 `interface.display_name`、`short_description` 和 `default_prompt`。
4. 校验 frontmatter：确认 `SKILL.md` 的 YAML 头至少有 `name` + `description`，且 `name` 与目录名一致。（若你本地装了 skill-creator 之类的校验脚本，此处跑它；仓库不内置该工具，也不依赖它。）
5. 在本页的目录结构和 README 相关入口里补充新 skill。
6. 提 PR。

## skill 与 framework 的边界

| 属于 skill                         | 属于 framework                      |
| ---------------------------------- | ----------------------------------- |
| 创建新 world / plugin / 文档脚手架 | 运行时游戏循环、tool 调用、状态管理 |
| 一次性的代码生成、文件改造         | 玩家每一回合都用得到的功能          |
| 给开发者/作者的模板                | 给玩家/runtime 的 builtin tool      |

如果一个能力需要“在 game loop 的每个 turn 都被触发”，它应该是 plugin 或 builtin tool；如果它是“开发者偶尔跑一下来生成内容”，它就是 skill。

## 参考

- [agentskills.io](https://agentskills.io) — skill 规范源
- [`.claude/skills/create-plugin/SKILL.md`](../../.claude/skills/create-plugin/SKILL.md) — 创建插件
- [`.claude/skills/create-world/SKILL.md`](../../.claude/skills/create-world/SKILL.md) — 创建世界包
- [`.claude/skills/covel-static-turn-audit/SKILL.md`](../../.claude/skills/covel-static-turn-audit/SKILL.md) — 静态 turn flow 审计
- [docs/guide/plugin-authoring.md](./plugin-authoring.md) — 如果你要的是 framework 级能力而不是 skill
