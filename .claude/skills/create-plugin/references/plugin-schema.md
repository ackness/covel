# PLUGIN.md Frontmatter Schema Reference

Schema 使用 Zod strict 模式（`runtimeManifestSchema`），不允许未定义字段。

## Frontmatter 字段

| 字段 | 类型 | 必需 | 约束 |
|------|------|------|------|
| name | string | ✓ | 正则 `^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$` |
| description | string | ✓ | 至少 1 字符 |
| priority | int | ✓ | 0-1000 |
| version | string | | |
| runtimeType | enum | | `agent`（默认）/ `function` |
| handler | string | | function 类型需要，指向 JS 模块路径 |
| model | string | | agent 类型需要，如 `fast` / `ds` / `default` |
| pluginType | enum | | `core-plugin` / `plugin` |
| trigger | object | | 见下方 |
| tools | object | | 见下方 |
| input | object | | 见下方 |
| output | object | | 见下方 |
| config | Record | | 见下方 |
| i18n | Record | | `{ "en-US": "./PLUGIN.en.md" }` |

## trigger

```yaml
trigger:
  type: auto|manual|scheduled|conditional|event|error-retry  # 必需
  interval: <int>            # scheduled 时使用，正整数
  maxTriggerCount: <int>     # 限制最大触发次数，正整数
  condition: <string>        # conditional 时使用
  topic: <string>            # event 时使用
  maxRetryCount: <int>       # error-retry 时使用
  cooldownTurns: <int>       # 冷却回合数
```

## tools

```yaml
tools:
  builtin:                   # 框架内置工具
    - create-form
    - create-choices
    - create-notification
    - plugin-data-set
    - plugin-data-get
    - plugin-data-list
  local:                     # 插件自定义工具
    - ./tools/my-tool.js
```

## input

```yaml
input:
  inject:                    # 注入其他 runtime 的输出
    - from: <runtime-name>   # 来源 runtime
      field: <field-name>    # 字段名
      as: <tag-name>         # 注入为 XML tag
  tools:                     # 引用其他插件的工具
    - plugin: <plugin-id>
      runtime: <runtime-id>
```

## output

```yaml
output:
  schema: <path>             # 输出 JSON Schema 路径
  recordAs: <name>           # 作为 record 存储的名称
```

## config

```yaml
config:
  <field-name>:
    type: string|integer|number|boolean|enum  # 必需
    default: <value>         # 可选
    min: <number>            # 可选
    max: <number>            # 可选
    options: [<string>]      # enum 类型必需
    label: <string>          # 可选
    description: <string>    # 可选
```

## 优先级分带

| 区间 | 阶段 | 说明 |
|------|------|------|
| 0 | Start-Game | 点击开始游戏（保留），Turn 0 |
| 1-99 | Pre-Game | 仅首轮，游戏初始化 ，Turn 0 |
| 100-499 | Pre-Turn | 每轮，叙事前处理，主要处理只读数据，Turn 1->N |
| 500 | Narrator | 主叙事输出（已被 core-narrator 占用），Turn 1->N ｜
| 501-999 | After-Turn | 叙事后处理，主要处理写数据，Turn 1->N |
| 1000 | Audit | 审计（保留），Turn 1->N |

## 可用 builtin 工具

| 工具 | 用途 |
|------|------|
| create-form | 创建玩家填写表单（含 narrativeTemplate 占位符） |
| create-choices | 创建选项列表（决策点、分支剧情） |
| create-notification | 显示通知消息（info/success/warning/error） |
| plugin-data-set | 写入插件持久化数据（namespace + key + value） |
| plugin-data-get | 读取当前插件持久化数据 |
| plugin-data-list | 列出当前插件持久化数据 |

## 文件结构

```
plugins/<id>/
├── PLUGIN.md              # 必需
├── package.json           # 必需
├── PLUGIN.en.md           # 可选：英文版
├── tools/                 # 可选：自定义工具
│   └── my-tool.js
└── references/            # 可选：按需加载参考资料
```
