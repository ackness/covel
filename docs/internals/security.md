# 安全边界

这一页说明 Covel 服务端有哪些安全边界，以及每条边界为什么画在那里。它写给要改服务端、部署托管实例，或者想知道“批准一个社区插件意味着什么”的人。

相关内容在别的页面：

- 每条路由的鉴权约定：[`../reference/api.md`](../reference/api.md#鉴权session-owner-token)
- 环境变量：[`../reference/env-registry.md`](../reference/env-registry.md)
- 桌面端代理设置：[`../reference/desktop-config.md`](../reference/desktop-config.md)
- 报告漏洞：[`SECURITY.md`](../../SECURITY.md)

下文多次提到“部署档位”（`DEPLOYMENT_TIER`）。`self` 是默认值，指桌面端和自己部署给自己用的实例；`demo` 和 `commercial` 是给别人用的托管实例，合称托管档位。

## Outbound requests (SSRF guard)

服务端替玩家向模型供应商发请求。SSRF 防护要保证这些请求不会被引到内网或本机上的服务。

`validateBaseUrl()`（`packages/ai-provider/src/adapters/http.ts`，字符串检查在 `adapters/http/url-safety.ts`）**默认放行**：任何公网 `https` 主机都可以访问，没有主机白名单的环境变量。第三方插件作者要访问自定义的供应商主机，不需要任何配置。

它拦截：

- RFC1918 和链路本地地址（`10.x`、`172.16-31.x`、`192.168.x`、`169.254.x`、`fc00::`、`fe80::`）；
- 云平台的元数据主机名（`metadata.google.internal`、`metadata.internal`）；
- 远程主机上不是 `https` 的 URL，以及不是 `http(s)` 的协议。

URL 里直接写 IP 时（IP 字面量）：

- 在选择传输方式之前，它就按与 DNS 结果相同的完整公网地址规则检查。
- 这条规则还拦截运营商级 NAT、基准测试、文档示例、未指定和组播地址段，也适用于嵌在 IPv6 里的 IPv4。
- 字面量连接不会触发套接字的 DNS 查询，所以不能只靠 DNS 那一层来拦。
- 在 `self` 档位，下面列出的回环地址仍然保留本机服务的例外。

IPv6 地址落在 `2000::/3` 里，并不足以说明它在公网可达。防护还会拒绝：

- IETF 保留和基准测试用的协议地址空间；
- 两个文档示例段 `2001:db8::/32` 和 `3fff::/20`；
- Teredo 和 6to4 过渡前缀。

IETF 分配的、确实全球可达的特定地址段仍然放行。这些特殊用途的分类依据 [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)。

在 `self` 档位（桌面端和自部署，默认值），回环地址（`localhost`、`127.0.0.1`、`::1`）可以访问，也不要求 `https`。这样 Ollama 这类本机服务才能用：服务端就是玩家自己的机器。

托管档位（`demo` / `commercial`）没有回环例外。原因是：

- 在那里，玩家可以在请求级预设（`X-Slot-Config`）里填一个模型 `baseUrl`；
- 而服务端的回环地址上跑着它自己的内部服务。

所以字符串检查和连接时的 DNS 检查都会拒绝这三个名字，对所有调用方都一样：核心供应商请求（包括运营者在 `llm.toml` 里配的端点）和插件的 `fetchWithRetry`。托管运营者要访问同一台机器上的模型，得给它一个公网 `https` 名字。

### DNS pinning

只做字符串检查，会在“检查”和“连接”之间留下一个 DNS 重绑定的空隙：检查时域名指向公网地址，连接时却被改成了内网地址。

直连模式下，下面两类请求都通过一个“钉住地址”的分发器（`adapters/http/dns-safety.ts`）解析 DNS：

- 核心供应商请求（`postJson` / `getJson` / `postFormData`）；
- 插件的 `fetchWithRetry` 辅助函数（`packages/ai-provider/src/plugin-utils.ts`；handler 里是 `ctx.utils.fetchWithRetry`，entry 模块里是 `covel.http.fetchWithRetry`）。

分发器的规则：

- 每一条 A/AAAA 结果都必须是公网可路由的地址。
- 回环主机名必须解析到回环地址（只在 `self` 档位；托管档位直接拒绝）。
- 套接字钉在通过检查的那个地址上，之后不再重新解析。

没有环境变量能关掉这个分发器。测试运行会替换全局 `fetch` 来冒充供应商；只有当这次运行自己的启动代码（`vitest.base.ts`）在 `globalThis` 上设了标记（`outbound-network.ts` 里的 `OUTBOUND_TEST_FETCH_HOOK`），传输层才把请求交给那个替身。用 `NODE_ENV=test` 启动的服务端没有这个标记，仍然走钉住地址的传输。

### Response size ceiling

回答供应商请求的端点可能是玩家自己填的，所以服务端不会对方发多少就缓冲多少。

- 框架从核心供应商请求读到的每个响应体，都边读边计数。计数超过上限就取消读取（`adapters/http/response.ts`，数值在 `adapters/http/constants.ts`）。
- `Content-Length` 超过上限时，在第一次读取之前就失败。

这些上限是安全限制，不是配额，也没有对应的设置项：

- JSON 或文本响应体：256 MiB。包括模型回答、错误响应体、模型列表、带 base64 图片的图片回答、模型数据库下载。
- 二进制媒体响应体（合成的音频）：50 MiB，也就是媒体入库时单个资源的默认上限。
- 流式回答里的单个 server-sent event（空行之前的文本）：256 MiB。流的总长度没有上限，由请求的时间预算来结束它。

响应体超过上限时，这次调用以供应商错误失败，不会对同一个端点重试。配置了备用模型的话仍然会去试，和遇到任何读不出来的回答一样。

这个上限不覆盖插件自己读取的响应：

- `fetchWithRetry` 把 `Response` 直接交给插件代码；
- 插件自己实现的 wire 自己发请求；
- `ctx.media.ingestUrl` 按它的 `maxBytes` 计数。

### Desktop proxy modes

桌面端的 `system` / `http` / `socks` 代理模式，只让框架自己的核心供应商请求和模型数据库请求走 Undici `ProxyAgent`（`packages/ai-provider/src/outbound-network.ts`）。对这些受信任的目标，由代理一侧解析 DNS，代替本地的地址钉住。

插件的 `fetchWithRetry` 永远走严格、直连、钉住地址的路径。这样第三方代码不能借代理的远程 DNS 绕过插件的网络边界。

### Self-tier exemption (core provider path only)

在 `self` 档位（桌面端和自部署的默认值，本来就只监听回环地址），直连的核心供应商路径，也就是用户自己配置的 LLM `baseUrl`，接受解析器对主机名给出的任何结果；套接字仍然钉在那个结果上。

这样做是因为单用户机器上有两种常见情况，“只许公网地址”的规则会把它们挡掉：

- TUN 代理（Clash、mihomo、sing-box、Surge）把所有域名映射到私有或基准测试地址段，再按 SNI 路由；
- 局域网里的端点，比如 `192.168.x.x` 上的 Ollama。

这个豁免故意开得很窄。它不适用于：

- 插件的 `fetchWithRetry` 路径：第三方代码不能探测本地网络，桌面安装也不行；
- IP 字面量 URL：字符串检查仍然拦截私有地址字面量；
- 托管档位（`demo` / `commercial`）：云网络里的私有地址可能通向真实的内部服务。

## Provider keys

模型供应商的密钥有两个来源，走两条路：

- 请求带来的密钥通过 `X-Provider-Keys` 请求头到达，服务端从不保存。
- 服务端环境变量里的密钥和平台密钥，以 `envApiKeys` 的形式单独交给网关。

供应商注册表（`packages/ai-provider/src/provider-registry.ts`）只在一种情况下附上环境密钥：解析出的目标 `baseUrl` 的源（origin）与受信任的配置（`llm.toml` 或已注册的供应商默认值）一致。

Web 客户端只发送它的请求用得到的供应商的密钥：

- 每个模型角色解析到的供应商（保存的绑定；没有绑定时是服务端自己为该角色配的供应商）；
- 请求里直接点名的供应商，比如探测模型列表时。

没有任何角色用到的供应商，它的密钥不会离开浏览器。服务端是别人的时候，这一点很重要。在客户端读到服务端的角色和预设之前，它会发送所有已保存的密钥。（`apps/web/src/services/api/model-settings.ts` 里的 `buildProviderKeysHeader`。）

这条规则防的是这种情况：请求级的自定义预设（`X-Slot-Config` 覆盖）把某个供应商改指向另一个源，如果不设防，它就会收到运营者的密钥。现在这样的预设拿不到环境密钥，也拿不到受信任的默认请求头，必须自带密钥。

内置供应商（`@covel/shared` 里的 `BUILTIN_PROVIDER_CONNECTIONS`）属于已注册的供应商默认值：以其中某个供应商命名的环境密钥，只会附到该供应商的官方源上，不会附到别处。模型列表请求（`POST /api/ai/models`）把目标当作请求级目标来解析，所以同一条规则在那里也成立。

回环地址（`localhost`、`127.0.0.1`、`::1`）上的模型不需要密钥就算就绪：Ollama 这类本机服务不用密钥。这只改变就绪检查；配了密钥仍然会发送，托管档位上出站防护仍然会拒绝这个请求。

插件可以注册自己的文本 wire（`covel.registerWires({ text })`）。wire 是一段替某种协议收发模型请求的插件代码。

- 哪个槽位的 `protocol` 写了这个 wire 的名字，wire 就会收到那个槽位解析出的端点和密钥，以及该槽位每次调用的提示词和回答。
- 没有点名它的槽位，什么都不会给它。
- wire 是插件的服务端代码，所以它能不能运行，由 [Community plugin code](#community-plugin-code) 的规则决定。

一个请求什么时候可以选用某个 wire：

- 请求属于某个会话：只有该会话启用了提供这个 wire 的插件才行（启用集合已经反映了玩家对社区插件的批准）。
- 请求不属于任何会话（连接测试、模型列表、世界生成）：可以选内置插件的 wire。在 `self` 档位，唯一的玩家批准了所有已加载的插件，所以也可以选社区插件的 wire；托管档位不可以。

请求级预设、`llm.toml` 槽位和运行时自己的槽位偏好都遵守这条规则。不满足时，调用以配置错误失败，错误信息会指出需要启用哪个插件。

密钥在磁盘上怎样存放：

- 桌面端存在 `<covelHome>/keys.env`，是明文的 `KEY=VALUE` 行，文件权限 `0600`，每次写入都会重新设置（在 Windows 上不起作用）。
- Web 端存在 `localStorage`（`covel:keys`）。
- 两处都不加密。渲染进程需要明文才能拼出 `X-Provider-Keys`，所以即使落盘加密，`covel:keys:load` 这条 IPC 通道（只接受受信任的发送方）也还是原样；而在未签名的构建上，Electron `safeStorage` 只会多出一个 macOS 钥匙串弹窗。

文件权限和浏览器的同源策略能挡住其他系统用户和其他网站。它们挡不住以该用户身份运行的代码，其中就包括已批准的社区插件（见 [Community plugin code](#community-plugin-code)）。

## 桌面窗口

桌面窗口启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，不启用子 frame 的 Node 集成。`preload.ts` 通过 `contextBridge` 暴露 `window.covelIpc`：应用元信息、只允许白名单通道的 `invoke` 和 `on`；订阅回调拿不到 Electron 事件对象。

敏感 IPC（包括明文密钥、REST token 和设置读写）要求发送方是其 `webContents.mainFrame`，且 URL 与主窗口已提交的回环 HTTP 源相同。同源子 frame 也被拒绝。恢复通道（重试启动、打开日志、配置或数据目录）同样要求主 frame，但也接受主进程生成的当前启动页。启动页不能读取密钥或 REST token。

`windows.ts` 阻止主 frame 导航或重定向到其他源；主进程主动加载启动页或应用地址不受此事件守卫限制。`window.open` 不创建新窗口：HTTPS 和回环 HTTP 链接交给系统浏览器，其他 HTTP 链接先确认，其他协议拒绝。这些限制不能防住受信任主页面内的恶意脚本，也不能隔离已批准的插件服务端代码。

发送方校验和启动错误投递的回归测试在 `apps/desktop/scripts/restart-server.test.mjs`；源和启动页 URL 匹配测试在 `apps/desktop/src/trusted-origin.selfcheck.ts`。

## Community plugin code

插件的服务端 JavaScript（`entry`、handler、guard、hook、wire）运行在服务端进程里，拥有服务端的全部权限。没有进程沙箱、VM 沙箱或模块沙箱。挡在社区包和这些权限之间的，只有玩家的同意：

- 清单读取共用纯 YAML 解析入口，加载、安装、校验和本地化工具都在解析前拒绝 `---js` 等引擎指令。
- 批准之前，`community` 包只是数据。安装、预览、列表和校验只解析它的文件，一个都不 import。两阶段批准（先 `covel:plugin-server-code`，再授予具体操作，见 [Hosted auth](#hosted-auth)）把守着第一次 import。
- 批准之后，这些代码能做服务端进程能做的一切：读写服务端系统用户的文件（`keys.env`、`llm.toml`、SQLite 文件），读 `process.env`，打开套接字，启动进程。
- `permissions.http` 是插件 API 上的白名单，作用于 `ctx.utils.fetchWithRetry`、`ctx.media.ingestUrl` 以及建立在它们之上的媒体绑定（`packages/runtime/src/function-runtime/http-permissions.ts`）。它能阻止一个包通过这套 API 访问它没有声明的源。它阻止不了直接调用全局 `fetch` 或 `node:https` 的代码。
- 绑定会话的存储视图、按插件查找工具、proposal 管线，都是插件 API 的权限边界，也有同样的局限。

`ctx.gateway.resolveSlot()` 是同一类边界。

- 不管问的是哪个槽位名，它都返回该槽位或预设的 `apiKey` 和鉴权请求头。实现自己 wire（`registerWires`）的插件需要这些来调用它的供应商。
- 插件清单只通过 `type: slot` 的设置项提到槽位，设置的值是玩家运行时的选择，所以没有一份静态名单可以拿来限制。
- 一个包就算不能从 `resolveSlot` 读到密钥，也能从它自己 wire 的 `config` 里读到，或者从它所在的进程里读到。
- 所以只在这一个方法上做按槽位的检查，看起来像隔离，其实不是，因此没有这样的检查。
- 替另一个插件发起的服务调用，从不携带密钥材料（`packages/runtime/src/plugin-services.ts` 里的 `lendGateway`）。

> [!IMPORTANT]
> 只有当你愿意把自己的供应商密钥交给某个社区包的作者时，才批准这个包。

因此，批准一个社区包，就等于把运行服务端的那个系统账号托付给它的作者。安装对话框和授权对话框都会说明：这些代码在没有进程沙箱的情况下运行。

有两个更省事的办法考虑过，但没有采用。原因相同：它们看起来像隔离，其实不是。

- 扫描包里的 JavaScript，找 `node:` 导入、`process.env` 或 `eval`。把名字拆成两个字符串再拼起来就能绕过，而“扫描通过”会被人当成审计过。
- 用 `worker_threads` 加一个过滤 `import` 说明符的模块加载器。这什么都隔离不了：worker 拥有进程的文件和网络访问，还能不经 `import`，通过 `process.getBuiltinModule` 拿到内置模块。

真正的隔离需要一个权限受限的独立操作系统进程，或者一个 isolate，再加上一套通过消息跨越边界的插件 API。在把社区包分发给无法判断作者是否可信的玩家之前，要先做这项改动。

## Hosted auth

`demo` 和 `commercial` 档位强制两种令牌：

- 每个会话一个 **owner token**。它在创建会话时生成，只以哈希形式存在 `SessionRecord.metadata` 里，只返回一次。所有会话级路由都要它。
- 一个 **operator token**（`COVEL_DESKTOP_REST_TOKEN`）。它同时是万能钥匙，能通过任何 owner 检查。全局和管理类路由要它：创建和列出会话、写世界、AI 和模型路由、启用社区服务端代码。

托管档位缺少 operator token、媒体密钥或 CORS 源时，`validateSecurityPosture`（`apps/server/src/security-posture.ts`）会让启动失败。`self` 档位、桌面端和开发环境严格地什么都不做：令牌被忽略，单用户本地游玩不受影响。

社区服务端代码（`entry`、handler、hook、wire、运行时 JavaScript）的 import 由两阶段批准把守：先授予 `covel:plugin-server-code`，再授予具体操作。

### Server settings

有少数玩家设置要由服务端执行（比如 trace 保留多久）。所以服务端把它们存在自己的数据库里，浏览器通过 `PUT /api/config/server-settings` 写入。

这是第二扇门，比只限桌面端的那几个接口更窄。`/api/config/settings`、`/api/config/keys`、`/api/config/proxy` 和 `/api/config/data-root` 仍然要 `COVEL_DESKTOP_REST=1` 才开放：普通的自托管 Web 部署不能写文件、密钥、代理或路径。

- **谁能写。** 只有 `DEPLOYMENT_TIER=self`，也就是唯一的玩家拥有服务端的档位；桌面壳设了 bearer token 时，还需要带上它。在 `demo` / `commercial` 上，写入在检查令牌之前就被拒绝，operator token 也不例外：那里的值归运营者，来自环境变量。在 `self` 上，环境变量同样优先于存储的值。
- **能写什么。** 只能写 `SERVER_SETTINGS`（`packages/shared/src/env/server-settings.ts`）里列出的 key，值必须被它的 schema 接受。这份名单是封闭的，每个值都是枚举值或有范围的选项。可能指向路径、URL、主机或凭据的 key 不属于这里。出现未知 key 时，整个请求被拒绝。
- **能读什么。** `GET /api/config/server-settings` 在所有档位上都公开，只返回这些 key 的生效值。不要添加生效值必须保密的设置。
- **谁够得着。** 写入的来源检查（`origin_not_allowed`）和其他 `PUT` 一样适用。别人能访问到的 `self` 服务端，会让他们改这些设置，就像让他们使用其他所有路由一样。`self` 服务端只应该暴露给它的主人。

## Translations from outside a package

`$COVEL_HOME/translations`（`COVEL_USER_TRANSLATIONS_DIR`）存放不是随插件一起来的插件翻译：用户自己拷进去的翻译包，以及在这台机器上做的机器翻译。加载器把它们当数据读：

- 只读标签和 `messages`。提示词正文（`*.zh.md`）只从插件包里读，所以翻译改不了指令。
- 标签段只保留标签字段（`displayName`、`description`、`label`、`title`、`summary`、`about`），其余内容丢弃。插件自己的 locale 文件也是这样处理的。
- 同一段文本两边都翻译了时，以作者的翻译为准。
- 不跟随符号链接，只读普通文件。

有一种情况下，这些文本仍然会被模型读到：`messages` 条目翻译的是插件代码写进状态或上下文的文本。这让翻译包和世界包的设定文本属于同一类输入。也正因为如此，这个目录是一个由运营者控制的本地路径，没有安装接口。

## Package credits and author links

插件、世界或合集可以写明作者、许可证和主页，作者还可以加一段简短的话和最多六个带标签的链接（`author`、`license`、`homepage`；字段见 [`docs/reference/plugins.md`](../reference/plugins.md#作者信息)）。这是做包的人写的文字，会显示给还没开始玩的玩家。对它的限制：

- **只用于显示。** 宿主不根据这些字段做任何决定。提示词模板读取的世界视图里不包含它们，所以作者的话不会到达模型。
- **纯文本。** 那段话和标签按文本渲染：没有 Markdown，没有 HTML，没有图片。所以包不能让客户端在显示它的卡片时去请求远程资源。
- **只允许 `https` 链接。** 清单 schema 拒绝其他协议（`http:`、`javascript:`、`file:`），也拒绝带用户名或密码的地址，因为那可以用来隐藏真正的主机。
- **由玩家打开链接，先看到警告。** 点击后会显示完整地址和它的主机，并说明这个链接来自包的作者，Covel 没有检查过这个网站。玩家确认之后，链接才在系统浏览器里打开。主机名用 ASCII 显示，所以用其他文字仿冒的名字会显示成 `xn--…`。
- **只在游玩之前出现。** 作者信息出现在世界卡片、世界页面、会话准备界面和已安装的包列表里。游玩界面不显示。安装预览只显示作者名字，不显示链接。

## Page policy and external images

构建出的主页面带有一个 `Content-Security-Policy` meta 标签（`apps/web/src/lib/page-csp.ts`，由 Vite 构建注入；开发服务器没有它，因为 Vite 需要内联脚本和热更新用的套接字）：

```
script-src 'self'; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; connect-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

每一项的含义：

- **脚本**只能是应用自己的文件：没有内联脚本，没有内联事件处理器，没有 `eval`，没有远程脚本。构建出的页面只有一个外部模块脚本，没有任何内联内容（Zod 被配置成不去探测 `eval`，见 `apps/web/src/lib/zod-config.ts`）。
- **框架**（frame）只限本源。应用创建的唯一一个 frame 是下面说的插件 frame 宿主。
- `connect-src` 是本源（加上 `blob:` / `data:`）。
- 没有浏览器插件（`object-src 'none'`）。
- `base-uri` 和 `form-action` 固定为本源。
- `style-src` 保留了 `'unsafe-inline'`：React 的 `style` 属性、主题系统注入的规则和导入的主题 CSS 都需要它。去掉它是另外一步工作。
- `style-src` / `font-src` 允许 `https:`，因为导入的主题自己的 CSS 可能加载远程样式表和字体。
- 这份策略没有设 `img-src`。

`tests/e2e/page-policy.spec.ts` 会加载构建后应用的主要界面和一个带插件面板的会话，只要出现 `securitypolicyviolation` 事件就失败。

### Plugin HTML

插件的 `webview` HTML 是玩家批准过的代码，但它绝不能碰到应用所在的源：`localStorage` 里的设置和供应商密钥、cookie，以及带着玩家会话令牌的 API。它运行在应用页面往下的第二层 frame 里。

1. **frame 宿主**是 `/plugin-frame.html`，Web 构建里的一个静态文件（`apps/web/public/plugin-frame.html`），对所有插件和会话都是同一个。

   - 应用用 `sandbox="allow-scripts"`（没有 `allow-same-origin`）把它嵌进来，所以它是一个不透明源（opaque origin）。
   - 它按 URL 加载，不用 `srcdoc` 或 `blob:`。原因是：`srcdoc`、`blob:` 或 `data:` 的 frame 会继承创建它的页面的策略，那样应用页面就不得不允许内联脚本；而按 URL 加载的文档只受它自己响应里的策略约束。

   它的策略写在文件的 `<meta>` 里：

   ```
   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'
   ```

   Covel 服务端还会用响应头发送同一份策略，并加上 `sandbox allow-scripts; frame-ancestors 'self'`（`apps/server/src/middleware/plugin-frame-headers.ts`）。这样即使有人直接打开它的地址，这个文档也是不透明源，其他网站也不能把它嵌进去。不发这些响应头的静态托管，仍然有 `<meta>` 策略和 frame 的 `sandbox` 属性。

2. **插件文档**是 frame 宿主创建的一个 `srcdoc` frame，同样带 `sandbox="allow-scripts"`。它继承 frame 宿主的策略：

   - 内联脚本和样式可以运行；
   - 不能从网络加载任何东西；
   - frame 宿主上的 `frame-src 'none'` 阻止插件文档把自己导航到网络地址（文档自己的策略拦不住它自己的导航，父文档的 `frame-src` 可以）。

插件的 HTML 不经过 URL 传递。应用本来就持有它（`GET /api/ui-specs`，按那条路由的会话鉴权），再把它连同桥接端口一起发给 frame 宿主。所以：

- `/plugin-frame.html` 不接受插件名、会话名或文件名，没法用它去读别的插件或别的会话的文件。
- 这个文件是构建的一部分。桌面端（由它的回环 sidecar 提供页面）、browser-private 配置和离线使用都不需要别的东西，自托管的人也不用配置第二个源。
- 一个单独的真实源（另一个端口或子域名）不会比这里的不透明源多提供任何隔离，却要让每个自托管的人多配一个监听端口、DNS 名字或代理规则。

**桥接**（`apps/web/src/components/session/plugin-bridge.ts`）。应用和插件文档之间只有一条消息通道：

- 应用不监听任何 window `message` 事件。
- 对每个 frame 元素，它创建一个 `MessageChannel`，把一端转交给那个 frame 的 `contentWindow`。frame 宿主把它传给插件文档一次；之后在任一层 frame 里加载的文档都拿不到端口。
- 端口上收到的内容是不可信输入，用 Zod 解析。一个请求要指明宿主为该面板提供的某个操作（已绑定到所属插件），外加一个普通的参数对象。其他内容要么丢弃，要么用一段固定的失败文本回答。
- handler 的错误从不传过去，所以服务端错误或其中夹带的凭据都留在应用里。
- 桥接传递的是：插件自己的数据、语言、锁定状态、面板上下文和主题。
- 它不传会话令牌，也不传供应商密钥。插件 HTML 除了通过宿主提供的操作，没有办法调用 API。

应用自带字体（`@fontsource-variable/*`，SIL OFL 1.1），启动时不向任何字体主机发请求。

**Markdown 图片。** 故事文本和世界文档由同一个组件渲染（`apps/web/src/components/ui/markdown.tsx`）。

- 应用自己提供的图片（同源、媒体库、`data:` 和 `blob:`）立即加载。
- 其他源上的图片不会被请求。玩家看到一个写着主机名的占位，带两个选项：“加载此图片”和“在此世界中始终加载 {host} 的图片”。第二个选择按世界保存在 `media.allowedImageHosts` 设置里。
- 这样做有两个目的：模型不能把对话里的文字塞进图片 URL 带出去；玩家没见过的主机也得不到玩家的地址。
- 加载的图片不发送 referrer。
- 插件 webview 和 json-render 面板不是 Markdown，各有各的规则。

## Other server guards

**桌面菜单导入。** 桌面菜单里的导入会打开共用的包安装器，使用与 Web 导入相同的服务端校验、压缩包限制和信任流程。过去那些把目录或 ZIP 直接拷进资源目录的原生 IPC 通道已经不再开放。

**Hook 出错时。**

- 没有返回值的 hook 表示继续。
- 改写类 hook 失败时，之前成功的改写保留。
- 安全守卫的异常和超时仍然按“拒绝”处理（fail-closed）。如果把所有 hook 故障都当成“继续”，就会绕过批准和提交守卫。
- 改写的 trace 只记录改了哪些 key 的摘要，不记录改写前后的完整提示词。

**会话写入。** 会话变更、玩家操作、恢复挂起和操作 RPC，共用 `routes/api/session/locked-mutation.ts` 里的存活会话守卫。

- 它们在持有会话锁的时候、写入之前，重新检查：会话是否存在、owner 授权、不可变的会话代次（incarnation）、删除标记，以及调用方允许的状态。
- 如果一个操作的 SSE 响应已经打开，进入被拒时会通过 `error.occurred` 报告，机器可读的错误码与 JSON 守卫相同。
- 脱离主流程的后台运行时作业保留它们各自的准入锁和提交锁。

**读取执行状态。** `GET /api/sessions/:id/execution` 把通过 owner 授权的那个会话代次，绑定到已有的响应侧读取屏障上。

- 如果查询进行中，这个会话消失了，或者用同一个公开 ID 重建了，响应会被换成 `409 session_incarnation_changed`。新会话的重试输入不会返回给旧请求。
- 这个检查不等待长时间运行的会话操作释放它的锁。

| Guard              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Code                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bind address       | 默认监听 `127.0.0.1`；设置 `COVEL_BIND_HOST` 才改为 `0.0.0.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `apps/server/src/app.ts`                      |
| Host name          | 在 `self` 档位（默认、桌面端、`pnpm dev`），请求头 `Host` 里的主机名必须是 `localhost`、`127.0.0.1`、`[::1]`，或列在 `COVEL_ALLOWED_HOSTS` 里，否则所有方法都在进入任何路由和静态文件之前以 `403 host_not_allowed` 拒绝。回环监听只限制谁能连上，不限制浏览器用什么名字连上：DNS 重绑定让攻击者自己的域名指向 `127.0.0.1`，浏览器就把本机服务当成那个网页的同源，CORS 和写入来源检查都会放行，但请求的 `Host` 仍是攻击者的域名。端口不比较。不带 `Host` 的请求不是浏览器发的，放行。`demo` / `commercial` 使用各自的鉴权规则，不做这个检查。自部署的网页版要从别的机器打开时，把它的域名或地址写进 `COVEL_ALLOWED_HOSTS` | `apps/server/src/middleware/host-guard.ts`    |
| Signed media URLs  | `MediaRef` 的 URL 用 `COVEL_MEDIA_TOKEN_SECRET` 签名。桌面壳必须提供这个密钥，否则图片加载不出来；Web 端使用每次启动生成的密钥                                                                                                                                                                                                                                                                                                                                                                                 | `apps/server/src/middleware/media-token.ts`   |
| Media library      | `GET /api/media/library` 和 `POST /api/media/library/delete` 不需要指明会话，就能列出和删除所有已存资源；列表还会签发作用域为 `media-library:` 的签名 URL，可以读取任何资源。它们只存在于一个玩家拥有整个存储的地方（`self`、桌面端）。在 `demo`、`commercial` 和 browser-private 配置上，它们回答 `503`，这个作用域也被拒绝，带不带 operator token 都一样，因为存储没有按所有者划分的媒体索引                                                                                                                 | `apps/server/src/routes/api/media-library.ts` |
| Session IDs        | `{worldId}-{uuid8}`，来自 `crypto.randomUUID()`，难以枚举                                                                                                                                                                                                                                                                                                                                                                                                                                                      | session routes                                |
| World IDs          | 白名单 `/^[a-z0-9_-]{1,64}$/i`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | world routes                                  |
| World reads        | `GET /api/worlds` 和 `GET /api/worlds/:id` 在所有档位上都不需要身份：能访问到服务端的人就能读每一条世界记录，包括已存储（生成的）世界里内嵌的角色、设定集、契约数据，以及作者标记为隐藏的内容。写入有把守，读取没有。托管部署如果不能把这些内容给每个访客看，就必须把服务端放在自己的访问控制后面                                                                                                                                                                                                              | `apps/server/src/routes/api/worlds/crud.ts`   |
| World gallery      | `GET /api/worlds/:id/gallery*` 不需要会话就提供世界包里的图片，能列出世界的人都能访问。请求给出文件地址的两个部分；只有当图库列表本身包含这个文件时才会应答：一张位图（PNG、JPEG、WebP，绝不是 SVG），由包的 `media/gallery.json` 列出且不晚于开场；没有那个文件时，则是直接位于某个公开的 `kind: media` 来源里的文件。路径在包内解析，拒绝符号链接；`enabled: false` 或 `visibility: hidden` 的来源不提供。它提供的唯一一个音频文件是 `world.yaml` 里 `themeMusic` 指定的 `.mp3` / `.wav`，遵守同样的路径规则 | `apps/server/src/world-data/gallery.ts`       |
| Write origin       | CORS 只能阻止页面读取响应；“简单”的跨站请求（表单提交、`text/plain` 的 `fetch`）仍然会执行处理函数。带 `Origin` 的 `POST` / `PUT` / `PATCH` / `DELETE`，除非这个源在 CORS 白名单上，或者它的主机就是请求发往的主机（`Host`，在代理后面是 `X-Forwarded-Host`），否则在进入任何路由之前就以 `403 origin_not_allowed` 拒绝。不带 `Origin` 的请求是非浏览器客户端，放行。这不是身份验证；DNS 重绑定由上面的 Host name 检查挡住                                                                                                                                                                                             | `apps/server/src/middleware/origin-guard.ts`  |
| Rate limiting      | `rateLimiter()` 和 `singleFlight()`；`RATE_LIMIT_RPM` 只设置 `GET /api/events/stream` 的额度（每个 IP 每分钟，默认 60）；其余路由的额度写死在各路由里，例如媒体上传 10、`POST /api/actions` 30、读取会话状态 120（每分钟）。每个客户端地址对每条具体路径有一份额度，对每个路由模板（`/api/sessions/:id/state`）还有第二份，是前者的八倍。这样每个会话有自己的额度，而轮换路径参数会停在较大的那一份上。计数表最多保存 10,000 条，先淘汰时间窗最早的                                                            | `apps/server/src/middleware/rate-limit.ts`    |
| Raw config files   | `GET` / `PUT /api/config/raw*` 以文本形式读写 `llm.toml`（桌面模式下还有 `config.toml`）。它们共用安装守卫：托管档位要 operator token，桌面壳下要桌面令牌，生产环境要 `COVEL_INSTALL_API_ENABLED=1`。文件名是一份固定名单，从不取自请求里的路径；`keys.env` 不在名单上。文本只有被服务端自己的解析器接受之后才会写入。`llm.toml` 的解析和校验错误只给行号、列号和键名，不含 `${VAR}` 替换后的值，所以拒绝信息、日志和设置页都不会带出密钥                                                                                                                                                                                           | `apps/server/src/routes/raw-config-api.ts`    |
| Error sanitization | 生产环境下 `app.onError` 返回 `"Internal server error"`；堆栈和路径只进 `console.error`。开发环境返回 `err.message`                                                                                                                                                                                                                                                                                                                                                                                            | `routes/api/bootstrap.ts`, `app.ts`           |

**失败响应里的错误信息。** 恢复挂起失败，以及快照和分支的意外失败，在完成必要的清理之后，都经过标准的错误分类器（`apps/server/src/api-error.ts`、`routes/api/resume.ts`、`routes/api/snapshots.ts`）。

- 恢复失败的响应不返回运行时结果。它只说明是运行时自己失败了，还是提交失败了，文本与一个回合通过 `runtime.failed` 报告给玩家的相同。其他任何异常在生产环境下都是一个笼统的 500。
- 已知的“分支时媒体引用失败”保留它的错误码，配一段固定的安全消息。
- 已经打开的世界翻译流（`routes/api/worlds/translate.ts`）使用同样清理过的错误内容，不改变它的 HTTP 状态。翻译被拒的原因会报告（没有译文、回复不是 JSON、占位符被改动）；意外的存储或供应商错误不会报告。
- 原因都记在服务端日志里。
- 这些改动并不表示所有 trace、游戏内容或日志输出面都做了清理。
