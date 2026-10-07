# 合集：把世界和配套插件一起发布

合集（Collection）是一份清单，列出一组要一起安装的世界与插件。它只是指针：装下来的仍是普通插件和普通世界，各自保留来源记录、可单独检查更新和卸载。合集本身不引入新的运行时概念。

适合的场景：你做了一个世界，同时为它写了几个插件，或者它依赖别人仓库里的某个插件。玩家粘贴一个链接，勾选、确认一次，就全部装好。

## 快速开始

```bash
pnpm create-collection my-pack            # 生成 my-pack/
pnpm create-plugin my-dice -t my-pack/plugins
# 用 create-world 技能或手工在 my-pack/worlds/<id>/ 下创建世界
pnpm validate:collection my-pack          # 静态检查
```

把 `my-pack/` 推到公开 GitHub 仓库后，玩家在「设置 → 安装与管理」粘贴仓库链接即可安装。

## 清单

`covel-collection.yaml` 放在合集目录的根部：

```yaml
schemaVersion: 1
id: lantern-tabletop
name:
  zh-CN: 灯冢跑团合集
  en-US: Lantern Barrow Tabletop
version: 1.2.0
covel: ">=0.0.45"
worlds:
  - path: worlds/lantern-barrow
plugins:
  - path: plugins/barrow-dice
  - repository: someone/covel-extra
    commit: 3f2a9c1e0b7d4a6f8c5e2d1b9a0f7e6d5c4b3a21
    path: plugins/weather
```

| 字段                            | 说明                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ |
| `schemaVersion`                 | 固定为 `1`                                                               |
| `id`                            | 小写字母、数字和连字符                                                   |
| `name`、`description`           | 展示用文本，可按语言给出                                                 |
| `version`                       | 合集自己的版本，仅用于展示                                               |
| `author`、`license`、`homepage` | 作者信息，仅用于展示；字段同[插件清单](../reference/plugins.md#作者信息) |
| `covel`                         | 适配的 Covel 版本范围，见下                                              |
| `worlds`、`plugins`             | 成员列表，合计 1–20 个                                                   |

成员有两种写法：

- **同仓库**：`path` 相对合集目录。安装时使用合集所在的那次提交。
- **其他仓库**：`repository`（`owner/repo`）加完整的 40 位 `commit`，`path` 可选。必须固定到提交，合集才是一份锁文件：作者发布之后，它安装的内容不会悄悄变化。

每个插件成员的目录本身必须是一个插件包（根部有 `PLUGIN.md` 和 `package.json`），每个世界成员的目录根部必须有 `world.yaml`。不支持嵌套合集，也不执行任何脚本。

没有清单的仓库同样可以一次安装：安装器会列出链接下找到的所有插件和世界。清单的作用是精确指定"装哪些"，以及引用其他仓库的包。

## 世界怎样声明需要的插件

世界不点名插件，而是声明需要的能力：

```yaml
# worlds/lantern-barrow/world.yaml
pluginPolicy:
  requires:
    - action-check@1
```

合集里附带一个提供 `action-check@1` 的插件，或依赖 Covel 内置的提供者。完整语义见[世界数据参考](../reference/world-data.md)。

## 版本范围

`covel` 可以写在合集清单里，也可以写在插件 `PLUGIN.md` 的根部。语法只有比较式，用空格连接，全部满足才算适配：

```yaml
covel: ">=0.0.45"
covel: ">=0.0.45 <0.1.0"
```

支持 `>=`、`>`、`<=`、`<`、`=`，版本写成 `X.Y.Z`。不支持 `^`、`~` 或"或"。插件之间的兼容性由契约 ID（如 `action-check@1`）表达，所以不需要、也没有插件对插件的版本范围和依赖求解。

插件声明的范围由安装器强制：宿主版本不在范围内时拒绝安装，并同时给出两个版本号。合集清单的范围在预览时检查，不满足时安装按钮不可用。

## 检查

```bash
pnpm validate:collection my-pack
```

它运行与安装预览相同的完整性检查，以本仓库内置的插件作为"宿主已有的插件"：

| 发现                                                 | 级别 |
| ---------------------------------------------------- | ---- |
| 世界 `requires` 的契约没有任何提供者                 | 错误 |
| 合集中插件 `requires` 的契约没有已安装或包含的提供者 | 错误 |
| 宿主版本不在合集或插件声明的范围内                   | 错误 |
| 同一个插件或世界被列出两次                           | 错误 |
| 契约有多个提供者，而世界没有 `requested` 其中之一    | 警告 |
| 世界 `requested` 的插件既未安装也未包含在合集里      | 警告 |

固定在其他仓库的成员不会被下载，脚本会列出它们并提示结果不完整。有错误时以非零状态退出，可以直接放进 CI。

## 离线分发

```bash
pnpm pack:collection my-pack my-pack.zip
```

生成一个 ZIP：清单在顶层，加上清单列出的每个成员（不含 `node_modules` 和隐藏文件）。玩家在「设置 → 安装与管理」把它拖到"合集包"区域导入。ZIP 必须包含全部成员，所以含有其他仓库成员的合集不能打包。离线导入没有预览步骤，完整性检查的错误会直接阻止安装。

## 安装时发生什么

- 预览不写入任何文件，也不执行插件代码。每个成员都有自己的固定提交和内容摘要。
- 玩家勾选要装的成员并确认一次。所选成员作为一个整体安装：先插件后世界；任何一个失败，本次已装的都会移除。
- 装了插件需要重启后端一次。世界立即可用。
- 安装不等于授权：社区插件在每个会话中仍按现有流程单独请求执行授权。

完整性检查同时验证插件根 `requires` 和世界 `pluginPolicy.requires`；“已安装 + 本次所选”中缺少提供者时，预览和静态校验均报错。
