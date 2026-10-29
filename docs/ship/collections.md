# 合集

合集是一份清单，写着“这几个世界和插件要一起装”。玩家粘贴一个链接，勾选，确认一次，就全装好了。

什么时候用它：

- 你做了一个世界，还为它写了几个插件。
- 你的世界需要别人仓库里的某个插件。

合集只在安装时起作用。装好之后，里面的每个世界和插件都是独立的，可以单独更新和卸载。世界列表中的“有更新可用”与应用包版本的方式见[世界安装与更新](../reference/world-installation.md#更新与数据保护)。

合集不会把自己的信任传给成员：每个插件按其安装记录中的来源仓库单独判断，固定在其他仓库的成员也一样。离线 ZIP 合集不享受可信来源自动授权，见[可信来源](../reference/plugin-installation.md#可信来源)。

## 做一个合集

下面把[第一个世界](../worlds/first-world.md)和[第一个插件](../plugins/first-plugin.md)里做的东西打成一个合集。命令都在 Covel 仓库的根目录运行。

### 1. 生成文件夹

```bash
pnpm create-collection tidelamp-pack ~/tidelamp-pack
```

```text
tidelamp-pack/
├── covel-collection.yaml     清单
├── README.md
├── plugins/
└── worlds/
```

### 2. 把世界和插件放进去

```bash
cp -R ~/.covel/worlds/tidelamp ~/tidelamp-pack/worlds/
cp -R ~/.covel/plugins/tavern-rumors ~/tidelamp-pack/plugins/
```

### 3. 在清单里列出它们

打开 `~/tidelamp-pack/covel-collection.yaml`，把最后两行改成：

```yaml
worlds:
  - path: worlds/tidelamp
plugins:
  - path: plugins/tavern-rumors
```

### 4. 检查

```bash
pnpm validate:collection ~/tidelamp-pack
```

```text
✓ tidelamp-pack: 1 plugin(s), 1 world(s) checked against Covel 0.0.51
```

清单是空的时候，它会这样提示：

```text
✗ (root): a collection lists at least one world or plugin
```

### 5. 发出去

两种方式，选一种：

- **放到 GitHub。** 把 `tidelamp-pack/` 推到一个公开仓库。玩家在 **设置 → 安装与管理** 粘贴仓库链接。
- **打成一个文件。** 运行下面的命令，把得到的 ZIP 发给玩家。他在同一个页面把它拖到“合集包”区域。

```bash
pnpm pack:collection ~/tidelamp-pack ~/tidelamp-pack.zip
```

## 清单怎么写

```yaml
schemaVersion: 1
id: tidelamp-pack
name:
  zh-CN: 潮灯镇合集
  en-US: Tidelamp Pack
version: 0.1.0
covel: ">=0.0.51"
worlds:
  - path: worlds/tidelamp
plugins:
  - path: plugins/tavern-rumors
```

| 字段                            | 说明                                         |
| ------------------------------- | -------------------------------------------- |
| `schemaVersion`                 | 固定写 `1`                                   |
| `id`                            | 合集的 ID：小写字母、数字和连字符            |
| `name`、`description`           | 显示给玩家的名字和简介，可以按语言分别写     |
| `version`                       | 合集自己的版本，只用于显示                   |
| `author`、`license`、`homepage` | 作者信息，只用于显示                         |
| `covel`                         | 它需要的 Covel 版本，见[版本范围](#版本范围) |
| `worlds`、`plugins`             | 要装的世界和插件，加起来 1 到 20 个          |

## 引用别人仓库里的插件

世界需要的插件不是你写的，就在清单里指向它所在的仓库：

```yaml
plugins:
  - repository: someone/covel-extra
    commit: 3f2a9c1e0b7d4a6f8c5e2d1b9a0f7e6d5c4b3a21
    path: plugins/weather
```

`commit` 必须是完整的 40 位提交号。这样做是为了保证：你发布之后，玩家装到的永远是你测过的那一版，不会因为对方仓库更新而悄悄变掉。

含有别人仓库成员的合集不能打成 ZIP，只能通过 GitHub 链接安装。

## 世界怎样说明它需要什么

世界不直接点名某个插件，而是说它需要哪种能力：

```yaml
# worlds/tidelamp/world.yaml
pluginPolicy:
  requires:
    - action-check@1
```

这句话的意思是“我需要一个能做行动判定的插件”。合集里带一个提供这种能力的插件，或者用 Covel 内置的，都可以。没有任何插件提供它时，检查会报错。

## 版本范围

`covel` 写的是“这个包需要哪些版本的 Covel”。合集的清单和插件的 `PLUGIN.md` 里都可以写。

```yaml
covel: ">=0.0.45"
covel: ">=0.0.45 <0.1.0"
```

- 可以用 `>=`、`>`、`<=`、`<`、`=`，版本写成 `X.Y.Z`。
- 多个条件用空格隔开，要全部满足。
- 不支持 `^` 和 `~`。

玩家的 Covel 版本不在范围里时，安装会被拒绝，并同时显示两个版本号。已经装好的插件也一样：Covel 升级后如果超出了范围，那个插件就不再加载。

## 检查会查什么

`pnpm validate:collection` 查的内容和玩家安装时看到的预览一样：

| 问题                                         | 结果 |
| -------------------------------------------- | ---- |
| 世界需要的能力，没有任何插件提供             | 报错 |
| 插件需要的能力，没有任何插件提供             | 报错 |
| 当前的 Covel 版本不在声明的范围里            | 报错 |
| 同一个世界或插件被列了两次                   | 报错 |
| 一种能力有多个插件提供，而世界没有指定用哪个 | 警告 |
| 世界想用的某个插件既没安装，也不在合集里     | 警告 |

有报错时命令以失败结束，所以可以直接放进自动检查里。别人仓库里的成员不会被下载下来检查，命令会把它们列出来，提醒你结果不完整。

## 玩家安装时会发生什么

- 先看到预览。预览不会写入任何文件，也不会运行任何代码。
- 勾选要装的内容，确认一次。它们作为一个整体安装，先装插件，再装世界。
- 有一个失败，会撤回这次已经装上的包。安装期间已有会话的世界会保留，避免删掉刚创建的存档；删除失败的包也会保留。错误消息会列出未撤回的包，请处理后再重试。
- 装了插件需要重启后端一次。世界马上可用。
- 装上不等于授权。插件第一次运行时，仍然会请玩家授权。

用 ZIP 导入时没有预览这一步，有问题会直接拒绝安装。合集的所有归档共用[安装器的解压预算](../reference/plugin-installation.md#归档限制)，超出时在写入前拒绝。

GitHub 和离线合集里的插件都遵守[安装器的运行时依赖规则](../reference/plugin-installation.md#安装器做什么不做什么)。作者需要把依赖打进发布文件；安装器不会替玩家安装依赖。

合集成员不能携带安装器的来源回执；世界和插件共用[保留文件规则](../reference/world-installation.md#api)。

## 没有清单也能一次装多个

仓库里没有 `covel-collection.yaml` 时，玩家粘贴链接后会看到那个目录下的所有世界和插件，同样可以一次装好。清单的作用是两件事：精确指定装哪些，以及引用别的仓库里的包。
