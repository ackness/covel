# 世界目录、安装与更新

官方目录为 [covel-worlds](https://github.com/covel-ai/covel-worlds)，默认英文首页，并提供中文及可扩展的其他语言 README。官方世界优先展示，社区世界单独收录，作者通过 PR 提交结构化目录条目。世界内容可以存放在作者自己的仓库。主仓内置世界仍由 Covel 发布，不参与外部世界更新。

## 设置页流程

在设置的资源包管理中输入公开 GitHub 仓库或 `/tree/<ref>/<path>` 链接。安装器识别根目录的 `world.yaml`，或列出下级目录中的世界（包括 `worlds/`），最多 20 个；选择后分别安装。多个世界必须有不同 ID，普通安装拒绝与现有目录或数据库世界冲突。安装成功立即加载，无需重启。

解析 ref 和下载归档都走现有代理配置，使用与插件相同的 URL 限制、固定 commit 校验、15 分钟签名预览和压缩包上限，详见 [插件安装](./plugin-installation.md)。限制针对整个 GitHub 归档。只安装所选世界目录，不执行脚本，不自动安装或授权依赖插件。作者应声明 `pluginPolicy`，用户在开局前检查内容、所需插件及其权限。

世界 GitHub 预览会在临时目录验证 manifest、外部维度和 worldData 引用，不使用本机世界 overrides。第三方提示词、设置和媒体仍需用户审阅。目录收录不等于安全审核。

## API

使用安装 API 门控，世界写操作还遵循全局世界写入权限。预览形状复用包预览（id、version、description、source、token、expiresAt）；`hasServerCode` 固定 false 表示此安装路径不会加载代码，不表示目录不包含脚本文件。

| 方法   | 路径                                       | 行为                                                                               |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| POST   | `/api/install/world/github/preview`        | `{url}` → `{items}`                                                                |
| POST   | `/api/install/world/github`                | `{token, acceptRisk:true}` → `201 {ok:true,kind:"world",id,restartRequired:false}` |
| GET    | `/api/install/worlds`                      | `{items:[{id,version,source,pendingUpdate}]}`                                      |
| POST   | `/api/install/world/github/update/preview` | `{id,url?}` → current、pinned 或 available + preview                               |
| POST   | `/api/install/world/github/update`         | `{token,acceptRisk:true}` → `201 {ok:true,kind:"world",id,restartRequired:true}`   |
| DELETE | `/api/install/world/github/update/:id`     | 取消暂存更新，返回 `{ok:true}`                                                     |

安装与更新签名按插件/世界及操作类型区分，不能交叉重放。ZIP 接口 `/api/install/world` 保留。来源记录 `.covel-install.json` 用于后续更新，手动安装或没有记录的世界不提供自动检查。

## 更新与数据保护

默认分支或指定分支可手动检查更新，tag/commit 固定版本；可用同仓库、同目录的新 ref 链接切换版本。只比较所选世界目录，显示版本、commit 和新增/修改/删除文件，需再次确认风险。

更新写入用户世界目录 `.covel-updates/<id>/`，后端重启、世界加载及文件监听开始之前替换。启动时再次核对来源与完整文件摘要，失败保留旧文件和错误状态，文件提升失败恢复旧目录。删除世界也取消该世界的暂存更新。

本地增删改文件会阻止替换。在 Covel 编辑器中修改的 GitHub 世界记录标记 `packageModified`，阻止后续更新及 seed/watch 覆盖；该自定义版本可继续使用和导出。若需恢复对原包的跟踪，需另行处理自定义内容后重新安装；删除世界会影响其会话，不能将删除作为无损的更新步骤。

世界更新不删除或重写已有会话，也不自动同步世界数据。存档中的玩家或插件修改由 [world-data sync](./world-data.md) 的 dry-run 和冲突检查单独处理。包外 overrides 不受文件替换影响，但可能改变新包的实际内容。文件回滚不承担玩法回滚或数据迁移。
