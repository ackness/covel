# Skills 使用与编写指南

Covel 仓库 `skills/` 目录下的每个子目录都是一个**独立的 skill**,遵循 [agentskills.io](https://agentskills.io) 规范,可以被支持 skill 协议的外部代理(Claude Code、Codex 等)按需加载。

> **重点**:skills 是纯文档资产。Covel server 既不读取也不执行 skills 目录;它们只对外部 IDE 代理有意义。

## 目录结构

```
skills/
├── README.md              # skills 总览
├── create-world/
│   ├── SKILL.md           # 入口,YAML frontmatter 必须有 name + description
│   └── references/        # 按需加载的细节参考
│       ├── world-yaml-schema.md
│       └── example-world.md
└── create-plugin/
    └── SKILL.md
```

## SKILL.md 模板

```markdown
---
name: my-skill
description: 一句话描述这个 skill 做什么、何时触发(代理通过 description 决定是否调起)
user_invocable: true # 可选,允许用户用 /my-skill 直接触发
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

- 需要 schema 细节时,加载 `references/xxx.md`
- 需要示例时,加载 `references/example-xxx.md`
```

### 关键原则

1. **入口要短**。SKILL.md 控制在 50-150 行,用最少的字让代理知道"这个 skill 是干嘛的、流程是什么"。细节都丢进 `references/`。
2. **References 按需加载**。代理只有真的需要时才会读 references——所以 references 可以写得很详细(几百行没问题)。
3. **frontmatter 的 description 是匹配关键**。description 决定代理是否触发 skill;写得越具体越准,越泛越容易乱跳。
4. **明确触发场景**。在 SKILL.md 顶部用"何时使用"段落把场景写明白,代理按这个判断。

## 在 Claude Code 中使用

Claude Code 启动时扫描以下两个目录的 skills:

1. `~/.claude/skills/<name>/SKILL.md`(全局,跨项目)
2. `<project>/.claude/skills/<name>/SKILL.md`(项目本地)

Covel 的 `.claude/skills/create-world/` 已经布好了项目本地 skill。你也可以把 `skills/<name>/` 软链或复制到 `.claude/skills/<name>/`,让本仓库的 Claude Code session 自动发现。

```bash
# 选项 A: 符号链接(推荐,改一份就行)
ln -s ../../skills/create-world .claude/skills/create-world

# 选项 B: 复制(适合 Windows 或不能用 symlink 的环境)
cp -r skills/create-world .claude/skills/
```

## 在外部代理中使用

任何能读 markdown 的代理都可以用 skills:

- **Codex**:用 `Read` 工具直接读 `skills/<name>/SKILL.md`
- **OpenAI Assistants / Custom GPTs**:把 SKILL.md 作为 system context 喂进去
- **VS Code Copilot Workspace** 等:把 skills 目录加入工作区
- **裸 LLM API 调用**:在 system prompt 里 `cat skills/<name>/SKILL.md` 的内容

## 添加新 skill 的流程

1. 在 `skills/<your-skill>/` 下建 SKILL.md(参考上面模板)
2. 如果有详细参考,放到 `skills/<your-skill>/references/`
3. 在 `skills/README.md` 的"当前 skills"表格里加一行
4. (可选)同步到 `.claude/skills/<your-skill>/` 让 Claude Code 自动发现
5. 提 PR

## skill 与 framework 的边界

| 属于 skill                         | 属于 framework                      |
| ---------------------------------- | ----------------------------------- |
| 创建新 world / plugin / 文档脚手架 | 运行时游戏循环、tool 调用、状态管理 |
| 一次性的代码生成、文件改造         | 玩家每一回合都用得到的功能          |
| 给开发者/作者的模板                | 给玩家/runtime 的 builtin tool      |

如果一个能力需要"在 game loop 的每个 turn 都被触发",它应该是 plugin 或 builtin tool;如果它是"开发者偶尔跑一下来生成内容",它就是 skill。

## 参考

- [agentskills.io](https://agentskills.io) — skill 规范源
- [skills/README.md](../../skills/README.md) — Covel 当前 skills 总览
- [docs/guide/plugin-authoring.md](./plugin-authoring.md) — 如果你要的是 framework 级能力而不是 skill
