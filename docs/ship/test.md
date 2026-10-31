# 测试插件

这一页教你不打开游戏、不花模型费用，就把插件测一遍。用的是[第一个插件](../plugins/first-plugin.md)里做的 `tavern-rumors`。

所有命令都在 Covel 仓库的根目录运行。

## 三种检查，从快到慢

| 检查     | 它能发现什么                     | 多久   |
| -------- | -------------------------------- | ------ |
| 校验     | 配置写错了：字段拼错、文件找不到 | 一两秒 |
| 离线运行 | 插件跑不通：没被触发、数据没存上 | 几秒   |
| 进游戏   | 真实模型的表现不如预期           | 几分钟 |

每次改完东西，先跑前两种。都通过了，再进游戏。

## 1. 校验

没有源码的玩家可以在设置的安装与管理里点“校验”。

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

校验只读文件，不运行你的代码。出错时它会说是哪个文件的哪个字段。

## 2. 离线运行

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

这条命令会真的运行你的插件，只是把模型换成了假的：模型该说什么，由你提前写在测试用例里。

用例在 `tests/runtime-cases.json`。脚手架已经给了两个。结果里每个用例都有一个状态：

```json
"name": "analyst-records-one-note",
"status": "passed",
```

全部是 `passed` 就通过了。有一个 `failed`，命令就以失败结束。

## 3. 自己加一个用例

一个用例回答三个问题：**给插件什么输入，假装模型怎么回答，最后应该得到什么。**

打开 `tests/runtime-cases.json`，在 `cases` 里加一项：

```json
{
  "name": "analyst-records-a-rumor",
  "runtimeId": "tavern-rumors/analyst",
  "message": "The innkeeper says the lighthouse keeper's daughter never left.",
  "llmResponses": [
    {
      "content": null,
      "finishReason": "tool_calls",
      "toolCalls": [
        {
          "id": "tc-1",
          "name": "notes-upsert",
          "arguments": "{\"record\":{\"id\":\"keepers-daughter\",\"kind\":\"analysis\",\"title\":\"The keeper's daughter\",\"text\":\"The innkeeper says she never left the lighthouse.\",\"tags\":[\"rumor\"]}}"
        },
        {
          "id": "tc-2",
          "name": "runtime-done",
          "arguments": "{\"reason\":\"recorded\"}"
        }
      ]
    }
  ],
  "expect": {
    "runtimeResults": [
      { "runtimeId": "tavern-rumors/analyst", "status": "success" }
    ],
    "pluginData": [
      { "namespace": "notes", "key": "keepers-daughter", "field": "title" }
    ]
  }
}
```

| 这一段         | 意思                                                    |
| -------------- | ------------------------------------------------------- |
| `runtimeId`    | 要运行插件里的哪一部分                                  |
| `message`      | 这一回合玩家发出的消息                                  |
| `llmResponses` | 假装模型的回答：它调用了哪些工具，传了什么              |
| `expect`       | 运行完应该成立的事：运行成功，并且 `notes` 里有这条记录 |

再跑一次第 2 步，新用例应该是 `passed`。

如果期望和实际对不上，例如把 `expect` 里的 `key` 写成了别的名字，你会看到：

```json
"name": "analyst-records-a-rumor",
"status": "failed",
```

往下翻，结果里会指出是哪一条期望没有满足：

```json
{
  "status": "failed",
  "message": "pluginData:notes"
}
```

## 什么时候该加用例

- 修了一个问题之后。加一个用例，保证它不会再出现。
- 插件遇到不该处理的内容时。例如这一回合没有传闻，它应该什么都不记。
- 改了数据的形状之后。旧用例里的期望要跟着改。

## 这一步测不到什么

离线运行用的是假模型，所以它测不出两件事：

- 真实模型会不会按你的提示词去做。这要进游戏看。
- 安装、授权和重启之后的表现。这是[下一页](./package.md)的内容。

## 想了解更多

给自己写的工具和函数写单元测试，以及用例文件的全部写法，见[插件测试参考](../plugins/testing.md)。

## 下一步

[打包并试装](./package.md)
