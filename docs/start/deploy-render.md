# 在 Render 上部署体验站

读完这一页，你会在 Render 的免费实例上跑起一个公开的 Covel 体验站：谁都能打开，玩家用自己的 API 密钥游玩，存档留在各自的浏览器里。玩家会看到什么、数据和密钥怎样处理，见[在公开体验站上玩](./hosted-trial.md)。

开始之前需要：

- 一个 Render 账号。
- 这个仓库，或者你的 fork，放在 Render 能连接的 Git 托管平台上。

## 它怎样运行

仓库根目录的 `render.yaml` 是一份 Render Blueprint。它用 `docker/Dockerfile` 构建一个免费套餐的 Web 服务 `covel-demo`。Render 在每次推送到所连分支时重新构建和部署。

这份配置让服务端以浏览器私有形态运行：`DEPLOYMENT_TIER=self`、`NODE_ENV=production`、`STORE_BACKEND=memory`。规则见[安全边界](../internals/security.md#host-profile)，简单说：

- 任何访客都可以创建会话、生成世界、列出服务商的模型和测试自己的密钥。
- 访问一个会话要用创建它时拿到的会话令牌。
- 写共享的世界目录、启用社区插件的服务端代码、读诊断信息、写服务端设置和文件、清理媒体，都要运维令牌（`COVEL_DESKTOP_REST_TOKEN`）。
- 服务端不检查请求的 `Host`，自己也不连接内网地址。玩家电脑或局域网上的模型由玩家的浏览器转发（[本地模型中继](./hosted-trial.md#用自己电脑或局域网里的模型)），不需要额外配置；它要求只有一个服务进程，Render 免费实例正是这样。

`render.yaml` 里每个变量的作用写在它旁边的注释里。

## 步骤

1. 用 fork 部署时，把 `render.yaml` 里 `COVEL_SOURCE_REPOSITORY` 的值改成你的仓库地址，并提交。玩家在提示里看到的源代码链接来自这个值。
2. 在 Render Dashboard 里选 **New → Blueprint**，连接仓库。Render 读取 `render.yaml`，列出要创建的服务 `covel-demo`。确认创建。
3. 等构建和部署完成。服务的日志里应当出现这两行：

   ```text
   Starting server on 0.0.0.0:10000...
   Server running at http://0.0.0.0:10000
   ```

4. 打开服务地址（`https://<服务名>.onrender.com`）。页面顶部应当出现提示“这是 Covel 的公开体验站”。
5. 检查健康接口：

   ```bash
   curl https://<服务名>.onrender.com/api/health
   ```

   返回里应当有这几项（提交号是 Render 这次部署的提交）：

   ```json
   {
     "operatorTokenRequired": true,
     "deployment": {
       "form": "browser-private",
       "source": {
         "repository": "https://github.com/ackness/covel",
         "commit": "<deployed commit>"
       }
     },
     "storage": {
       "data": {
         "backend": "memory",
         "durable": false,
         "frontendMode": "local"
       }
     }
   }
   ```

6. 需要做运维操作（例如写共享世界）时，在 Render Dashboard 的 **Environment** 里复制 `COVEL_DESKTOP_REST_TOKEN` 的值，填进网页 **设置 → 运维访问**。

## 免费实例的限制

- **内存 512 MB。** 镜像用一个 Node 进程运行服务（`node --import tsx`），`render.yaml` 里的 `NODE_OPTIONS=--max-old-space-size=256` 让 V8 在碰到容器上限之前回收内存。用同样的设置在本地启动，空闲时进程占 240–330 MB。
- **会休眠。** 15 分钟没有请求就休眠，下一次打开要等一分钟左右。休眠、重新部署和崩溃都会清空服务器内存，丢失的内容见[你的数据存在哪里](./hosted-trial.md#你的数据存在哪里)。
- **内存只增不减。** 服务器不清理闲置的会话副本：每个玩家打开过的会话都留在内存里，直到下一次重启。玩的人多时，内存可能涨到上限，被平台重启。
- **限流额度是共用的。** 请求经过 Render 的代理，服务端看到的来源地址是代理的地址，所以同一路由的限流额度由所有玩家共用，人多时可能收到 `429`。`TRUSTED_PROXY_IPS` 只接受确切的 IP，写不了 Render 的代理网段。

## 不要这样做

- **不要把运维令牌发给玩家。** 它能通过任何会话的令牌检查。
- **不要在服务端配置模型密钥**（环境变量或 `llm.toml`）。任何访客都能创建会话，他们的会话会用这些密钥调用模型。
- **不要安装社区插件。** 社区插件的服务端代码没有沙箱，运行在每个玩家的密钥都会经过的进程里。
- **不要设置 `COVEL_ALLOWED_HOSTS`。** 浏览器私有形态不做 Host 检查，设置了它服务端会拒绝启动。
- **不要打开 `ENABLE_DEBUG_PAGE`。** 它会对访客列出服务器上的所有会话。

## 出错时

| 现象                                             | 处理                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Render 提示 “No open ports detected”             | 确认 `COVEL_BIND_HOST=0.0.0.0`、`SERVER_PORT=10000` 没有被改掉                                           |
| 部署后实例因为内存超限反复重启                   | 看日志里重启前在做什么。免费实例放不下时，把服务换成付费实例                                             |
| 启动日志提示 `COVEL_ALLOWED_HOSTS has no effect` | 删掉这个变量                                                                                             |
| 页面顶部没有体验站提示                           | 用上面的 `curl` 检查：`deployment.form` 应为 `browser-private`，`storage.data.frontendMode` 应为 `local` |
| 提示里没有源代码链接                             | 设置 `COVEL_SOURCE_REPOSITORY`，值必须是 `https://` 地址                                                 |
| 提示里的源代码链接没有版本号                     | Render 没有提供 `RENDER_GIT_COMMIT` 时，用 `COVEL_SOURCE_COMMIT` 写上提交号                              |
| 玩家偶尔收到 `429`                               | 共用的限流额度用完了，过一分钟再试                                                                       |
| 构建失败                                         | 在 Render 的构建日志里找第一条错误。本地可以用 `docker build -f docker/Dockerfile .` 复现                |
