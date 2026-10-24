# 从源码运行

如果你想修改框架、在仓库里开发世界和插件，或者所用系统没有安装包，可以从源码运行。完成后，浏览器里会打开和桌面版相同的界面。

## 开始之前

- [Git](https://git-scm.com/)。
- Node.js 和 pnpm。版本写在仓库根目录的 `mise.toml` 里；装了 [mise](https://mise.jdx.dev/) 的话，在仓库里运行 `mise install` 即可得到正确的版本。

当前源码要求 Node.js 26.12.1 或更新的 26.x 安全版本。升级源码时也要更新运行时；只更新依赖不会修复 Node 的原生解码器。

## 1. 获取代码并安装依赖

```bash
git clone https://github.com/ackness/covel.git
cd covel
pnpm install --frozen-lockfile
```

## 2. 启动

```bash
pnpm dev
```

这会同时启动网页（端口 5173）和后端（端口 3001）。打开 <http://localhost:5173>，你会看到世界选择页。

存档写入本机的 SQLite 数据库。停止时按 `Ctrl+C`；如果有进程残留，运行 `pnpm stop`。

## 3. 连接模型

最简单的做法和桌面版一样：在界面的 **设置 → 模型** 里添加服务商、填写密钥，见[连接模型](./models.md)。这些设置保存在当前浏览器里。

想把模型配置放在文件里（例如团队共用一份）时，从示例复制三个文件：

```bash
cp .env.example .env              # 后端和存储设置
cp llm.toml.example llm.toml      # 模型用途和端点
cp .env.llm.example .env.llm      # 服务商 API 密钥
```

这三个文件不要提交到仓库。界面里的选择优先于 `llm.toml`，但不会写入这个文件。

## 和桌面版的区别

|                | 桌面版                  | 从源码运行                                                |
| -------------- | ----------------------- | --------------------------------------------------------- |
| 界面设置和密钥 | `~/.covel/` 下的文件    | 当前浏览器的本地存储                                      |
| 你的世界       | `~/.covel/data/worlds/` | `~/.covel/worlds/`（可用 `COVEL_USER_WORLDS_DIR` 修改）   |
| 你的插件       | `~/.covel/plugins/`     | `~/.covel/plugins/`（可用 `COVEL_USER_PLUGINS_DIR` 修改） |
| 内置世界和插件 | 打包在应用里            | 仓库的 `worlds/` 和 `plugins/`                            |

## 常用命令

| 命令              | 作用                       |
| ----------------- | -------------------------- |
| `pnpm dev`        | 启动网页和后端             |
| `pnpm dev:server` | 只启动后端                 |
| `pnpm dev:web`    | 只启动网页                 |
| `pnpm stop`       | 结束残留的开发进程         |
| `pnpm check`      | 静态检查，和 CI 的门禁相同 |
| `pnpm test`       | 运行全部单元测试           |

调试页面在 <http://localhost:5173/debug>，可以查看每个回合里每个插件的模型请求、工具调用和耗时。

## 遇到问题

| 现象                        | 处理                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `pnpm install` 提示版本不符 | 用 `mise install` 安装 `mise.toml` 指定的 Node.js 和 pnpm         |
| 启动时提示数据库被占用      | 另一个 Covel 进程（例如桌面版）正在使用同一个数据库文件，先退出它 |
| 端口被占用                  | 运行 `pnpm stop`，或者在 `.env` 里修改 `SERVER_PORT`              |

## 想了解更多

- [全部环境变量](../reference/env-registry.md)
- [不常用的命令](../internals/commands.md)
- [贡献指南](../CONTRIBUTING.md)

## 下一步

- [第一个世界](../worlds/first-world.md)
- [第一个插件](../plugins/first-plugin.md)
