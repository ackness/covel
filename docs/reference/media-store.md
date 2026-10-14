# 媒体存储

`MediaStore` 是 Covel 保存媒体文件的地方：生成的图片、音频、视频和其他文件。存进去的每个文件得到一个 `MediaRef`，之后消息、插件数据和界面都只保存这个引用，不保存文件内容。

这一页讲它的接口、几种存储方式、谁有权读一个文件、文件什么时候可以删除，以及玩家在设置里看到的媒体库。它适合写存储后端、写生成媒体的插件，或者运维一台服务器的人。

两个贯穿全页的词：

- **归属（owner）**：第一个存下这个文件的会话。
- **引用（ref）**：另一个会话声明“我也要用这个文件”。

## Contract

每个后端都实现下面的接口：

```ts
interface MediaStore {
  put(
    blob: Uint8Array | Blob,
    mime: string,
    meta?: object,
    initialRef?: { sessionId: string; pluginId?: string },
  ): Promise<MediaRef>;
  get(ref: MediaRef): Promise<Uint8Array | Blob>;
  exists(id: string): Promise<boolean>;
  resolveUrl(ref: MediaRef): Promise<string>;
  delete(id: string, opts?: { force?: boolean }): Promise<void>;
  lookup(id: string): Promise<MediaAssetLookup | null>;
  recordOwnership(
    id: string,
    ownerSessionId: string,
    ownerPluginId?: string,
  ): Promise<void>;
  addRef(id: string, sessionId: string, pluginId?: string): Promise<void>;
  removeRef(id: string, sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  isReferencedBy(id: string, sessionId: string): Promise<boolean>;
  listAssets(): Promise<readonly MediaAssetRecord[]>;
  listByMetadata(
    sessionId: string,
    filter: Readonly<Record<string, unknown>>,
  ): Promise<readonly MediaAssetRecord[]>;
  listRefs(): Promise<readonly MediaRefRecord[]>;
  cleanup(
    protectedIds: ReadonlySet<string>,
    policy?: MediaLifecyclePolicy,
  ): Promise<MediaCleanupResult>;
  openReadStream?(ref: MediaRef): Promise<ReadableStream<Uint8Array>>;
  close?(): void | Promise<void>;
}
```

类型定义在 `packages/shared/src/types/media.ts`。

**文件 ID 就是内容的哈希**

- `put()` 用文件内容算出 SHA-256 作为 ID。内容相同的文件只存一份。
- 重复存入相同内容时，保留第一次存的元数据。

**元数据里的 U+0000**

- 四种后端在保存元数据 JSON 时都会去掉 U+0000 字符，但不会改动调用方传进来的对象。
- 清理之后会重名的键，在文件公开之前就被拒绝。
- 文件本身的字节不动，包括值为 0 的字节。ID 由原始字节决定。

**`releaseSession(sessionId)`** 在会话被删除时使用：它一次清掉这个会话的归属和引用，文件的字节和其他会话的引用保留。

## HTTP content safety

**上传：`POST /api/media`**

- 只接受图片（`image/*`）。
- 保存之前，把 MIME 类型整理成小写、不带参数的形式。
- 拒绝 SVG。原因：SVG 在应用自己的域名下打开时可以执行脚本。
- 比较 MIME 类型时不分大小写，也忽略参数。所以 `image/SVG+xml; charset=utf-8` 同样被拒绝。

**上传时的会话检查**

上传使用同一条会话记录来鉴权，并记下它的“代次”（incarnation，同一个 ID 的会话每次重建都会变）。在登记归属和引用之前，服务端在会话锁里再检查一遍：归属者、代次、是否处于 active 状态、是否正在删除。

| 情况                                     | 结果                         |
| ---------------------------------------- | ---------------------------- |
| 这期间归属者变了                         | `401`                        |
| 代次变了，或者会话不再 active / 正在删除 | `409`                        |
| 被拒绝之前已经存下的字节                 | 没有归属，之后可以被清理回收 |

**读取：`GET /api/media/:id`**

对保存下来的 SVG 文件，响应带上 `Content-Disposition: attachment` 和 `Content-Security-Policy: sandbox`。

- 历史数据或生成方写入的 MIME 值大小写混杂、带参数时，同样适用。
- 普通响应和 `304` 缓存复核响应都带这两个头。

## Backends

| 后端                | 工厂函数                                        | 字节存在哪里                                          | `openReadStream()`                      |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Memory              | `createMemoryMediaStore()`                      | 进程内存                                              | 有（一次给出整块）                      |
| SQLite/local-fs     | `createSqliteMediaStore(dbPath, { mediaRoot })` | 本地文件，路径是 `{mediaRoot}/{ab}/{cd}/{sha256}.bin` | 有（真正的流式读取）                    |
| PostgreSQL          | `createPgMediaStore(databaseUrl)`               | `media_assets.body` 列，类型 `bytea`                  | **没有**，见下面的“PG streaming caveat” |
| IndexedDB（网页端） | `createIndexedDbMediaStore({ dbName })`         | 浏览器 IndexedDB 的 Blob 存储                         | 有（`Blob.stream()`）                   |

### 浏览器里的显示缓存

网页端另有一份“渲染用的 blob 缓存”。它和 `MediaStore` 后端是两回事。

- 网页端解析媒体时，先确认会话有权读取，再查这份缓存。
- 缓存记录会被校验。格式不对或对不上的记录被忽略，改用经过校验的网络字节。
- 并发写入时保留第一条记录，用一个 IndexedDB 事务完成。写入和删除以事务完成为准。
- 缓存出错只产生诊断信息，不会让已经成功下载的媒体显示失败。

连接的规则：

- 显示缓存和应用的键值存储在每个页面里共用一个浏览器连接。
- 打开失败或句柄已关闭时，之后的操作可以重试。数据库版本变化时释放旧句柄。
- 打开被阻塞时立即返回失败，并放弃它最终的升级和连接。在那个原生请求结束之前，后面的调用直接复用这次失败，不再排队发起另一个被阻塞的打开。
- 缓存诊断不包含原始异常细节和签名 URL。
- 清除无效记录之前会再检查一次当前记录，不会删掉另一个标签页刚写入的有效记录。

### PG streaming caveat

`createPgMediaStore` 有意不实现 `openReadStream`。

- `bytea` 列会让驱动先把整个文件读进内存，再交给调用方。包一层“流式”只是把整个文件缓冲一遍，比直接 `get()` 没有任何好处。
- `apps/server/src/routes/api/media.ts` 的路由层已经判断 `typeof store.openReadStream === 'function'`，没有时自动改用 `get()`。调用方不需要改动。

> [!TIP]
> 如果在 PostgreSQL 上保存大于几 MiB 的媒体，可以考虑把字节放到 SQLite local-fs（`createSqliteMediaStore`），内核的其他状态仍然留在 PG。

## Media Wire Registries (image / speech / transcription / music)

这一节讲的是媒体的**生成**，不是保存。生成走 `@covel/ai-provider` 里可插拔的 wire 注册表（`packages/ai-provider/src/image/wire-registry.ts`、`packages/ai-provider/src/speech/wire-registry.ts`），位于 `MediaStore` 的上游。wire 产出字节之后，`ctx.images.generate()` / `ctx.speech.generate()` / `ctx.music.generate()` 才把它们存进 `MediaStore`。

一个 wire 实现一家服务商的请求和回答格式。

| 类型     | 内置 wire                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 图像     | `openai-images`（默认，`DEFAULT_IMAGE_WIRE`）、`dashscope-wan`                                         |
| 语音合成 | `openai-speech`（TTS，`POST /audio/speech`）                                                           |
| 语音转写 | `openai-transcription`（STT，`POST /audio/transcriptions`）                                            |
| 音乐     | 没有内置 wire（`packages/ai-provider/src/music/wire-registry.ts`）。各家没有共同的请求格式，由插件注册 |

服务商用“任务”回答的 wire，在 `compose` 里自己轮询，最后返回音频。

**选择 wire**

- 每个用途各选各的：`llm.toml` 里 `[covel.<slot>].providerRequestMetadata` 的 `imageWire` / `speechWire` / `transcriptionWire` / `musicWire` 写 wire ID。
- 没写时使用内置的默认值。`musicWire` 没有默认值，不写就是配置错误。
- 不认识的 ID 在生成时抛错，不会悄悄换成别的 wire。

见 [slots.md](./slots.md)。

**注册 wire**

- 插件在 `entry` 模块里调用 `covel.registerWires({ image?, speech?, transcription?, music?, text? })`。ID 自动加上前缀，成为 `<pluginId>/<wireId>`；是否加载受信任级别控制。见 [plugin-extensions.md § 模型与新协议](./plugin-extensions.md#模型与新协议)。
- 随框架打包的代码也可以直接调用 `registerImageWire` / `registerSpeechWire` / `registerTranscriptionWire`。ID 是任意字符串，不是枚举。

## Metadata Conventions & Querying

`put()`、`ctx.media.put()` 和 `ctx.images.generate()` 都接受一个自由格式的 `meta` 对象，和文件一起保存。里面有两类键：

- **业务键**：插件自己定义，描述这张图“是什么”。例如 `kind`（`scene-background` / `character-sprite` / `illustration` / …）、`sceneId` 或 `characterId`、`variant`（`day` / `night` / …）。框架从不读取它们，它们只服务于查询它们的那个插件自己的约定。
- **框架键**：`pluginId` 和 `promptHash`。由 `ctx.images.generate()`（`packages/runtime/src/function-runtime/runtime-images-context.ts`）和 `ctx.speech.generate()`（`runtime-speech-context.ts`）自动写入。它们在调用方给的 `metadata` **之后**写入，所以插件无法覆盖它们。

### `listByMetadata(sessionId, filter)`

返回 `sessionId` 拥有的、并且 `meta` 包含 `filter` 里每一对键值的文件。

- 匹配方式是精确、浅层的子集匹配。四种后端共用一个实现：`packages/store/src/media-store/filter.ts` 的 `filterAssetsByMetadata`。
- `filter` 里某个值是 `undefined` 时，既匹配“没有这个键”，也匹配“这个键明确存成了 `undefined`”（比较用的是 `meta[k] === v`，两边都读到 `undefined`）。
- 只有基本类型的值（string / number / boolean / `null`）比较才有意义。对象和数组永远不匹配，因为 `===` 比较的是引用。
- 结果集预期很小：每个会话的媒体只有几十条，所以这里做的是全表扫描。`filter.ts` 里有 `ponytail:` 注释：数据量超出这个规模时，要下推到 SQL。
- `filter.ts` 不使用 Node 内置模块（和 `utils.ts` 不同），因为浏览器端的 MediaStore 也会导入它。

### `promptHash` idempotency

`promptHash` 让“同样的请求不生成第二次”。

**它由什么算出来**

| 调用                    | 参与计算的内容                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.images.generate()` | 生成参数（`prompt`、`negativePrompt`、`size`、`quality`、`n`、`background`），加上解析出的服务商、模型、协议、端点和规范化的 wire 元数据 |
| `ctx.speech.generate()` | 同样的模型身份，加上 `presetId`、`text`、`voice`、`format`                                                                               |
| `ctx.music.generate()`  | 同样的模型身份，加上 `presetId`、`prompt`、`lyrics`、`instrumental`、`durationSeconds`、`format`                                         |

- 不参与计算的：API 密钥、认证头、业务 `metadata` 和 `signal`。
- `ctx.images.generate()` 在查缓存之前先解析当前的图像绑定。把同一个用途改绑到另一个模型或 wire，缓存就失效。
- 语音和音乐同理：一个模型做出的一句话或一段音乐，在用途绑定到另一个模型之后不会再被返回；用途改回第一个模型时又可以返回。

**怎样命中**

1. 调用 gateway 之前，先查 `listByMetadata(sessionId, { promptHash, pluginId })`。
2. 已经有至少 `n` 个匹配的文件时（语音和音乐是 1 个），直接返回这些引用，带 `cached: true`，完全跳过对服务商的调用。

**要注意的两点**

- 提示词相同、`metadata` 不同的两次调用，会命中同一个缓存文件。磁盘上保存的是**第一次**调用给的元数据；返回的每个缓存引用带的是这一次调用的业务元数据。
- 只命中一部分（已有文件少于 `n`，例如上次有一张图没存成功）**不算**命中。这时重新生成整批，而不是悄悄少给几张。

## Ownership

SQLite 的 `media_assets.path` 保存相对 `mediaRoot` 的路径（`ab/cd/<sha256>.bin`）。`mediaRoot` 默认是数据库旁的 `media/`。读取、流式读取、修复和删除都使用当前目录。复制或备份时要把数据库和这个目录一起带走，搬迁后不需要改写记录。自定义的 `mediaRoot` 需要另行复制和配置。含绝对媒体路径的开发数据库必须重建，不提供迁移或兼容读取。

**SQLite / 本地文件的写入**

- `put()` 先把完整的字节写到目标目录里的一个独占临时文件，再原子地改名到内容路径，最后登记元数据。
- 重试时，如果发现一个“有文件、没有元数据”的孤儿文件，会替换它，不会因为文件存在就信任它。写入失败会删掉自己的临时文件。
- 写文件和 `get()` 里的读文件都是异步的，所以一张大图不会拖住其他会话。只有元数据那一行要排数据库的写队列；如果这期间文件被一次删除清掉了，这一步会重新把文件写上。

**归属和引用**

| 方法                | 作用                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `recordOwnership()` | 给文件设置第一个归属者。先到先得：第二次用不同的 `sessionId` 调用不会覆盖 |
| `addRef()`          | 给另一个会话读取权限，用于 fork 和快照                                    |
| `removeRef()`       | 移除一个会话的引用。可以重复调用；不删除字节，也不动归属                  |
| `isReferencedBy()`  | 归属者会话，或者有一条引用记录的会话，返回 true                           |

`ctx.media.put()` 和 `ctx.media.ingestUrl()` 在字节存好之后登记归属和本会话的引用。如果调用它们的 runtime 或 guard 在这期间被中止或超时，这次调用被拒绝，两样都不登记。没有归属的字节留给媒体清理去回收。

**`addRef()` 按 `(sessionId, mediaId)` 幂等**

`media_refs` 的 UNIQUE 约束不包含 `plugin_id`，它只作为“最先来源”的说明被记录下来。这样做是安全的：SQL 的 `UNIQUE` 把每个 `NULL` 都当成不同的值，如果约束里包含可以为空的 `plugin_id`，调用方传 `undefined` 时就会悄悄产生无数条重复记录。这个键的形状和 Memory、IndexedDB 一致，它们也用 `(sessionId, mediaId)` 作为 map 的键。

> [!WARNING]
> 只支持当前的 `(session_id, media_id)` 约束。使用旧的媒体引用结构的开发数据库需要重建，框架不迁移也不自动删除旧记录。

**`delete()`**

`delete()` 先移除指向这个文件的所有引用，再删除文件。SQL 后端把两步放在一个事务里。特别是，另一个 SQLite 进程不可能在“清引用”和“删文件”之间插入一条新引用。

**签名 URL：`GET /api/sessions/:id/media-token`**

- 在托管部署（`demo` / `commercial`）下，以及生产环境使用 MemoryStore 时（包括 `self` 的浏览器私有模式），需要会话归属者的凭据。
- 和其他会话路由一样，运维凭据也可以授权这个请求。
- 会话还必须拥有或引用了要读的文件，服务端才签发媒体 URL。

**上传和读取时的 MIME 规则**

- `POST /api/media` 接受 `image/*`，拒绝 `image/svg+xml`。
- 检查 MIME 类型时忽略大小写、两端的空白和参数。接受的上传保存成小写、不带参数的类型。
- 读取时，对历史文件的元数据也先做同样的整理：SVG 文件总是带 `Content-Disposition: attachment` 和 `Content-Security-Policy: sandbox`，缓冲响应和流式响应都一样。
- 保存下来的 MIME 参数仍然出现在读取响应的 `Content-Type` 里。

### 存入时同时建立引用

`put(bytes, mime, meta?, initialRef?)` 可以在公开字节的同一个临界区或事务里，建立一条初始引用。内容已经存在时也一样。

- 它不设置归属。
- 这条引用遵循通常的 `(sessionId, mediaId)` 先到先得规则。
- `put` 返回之前，清理就已经能看到这条引用。

### 世界数据导入时的临时引用

准备世界数据时，用上面这个操作把字节“钉住”，引用名是唯一的 `world-data-import:<uuid>`。冒号不在用户会话 ID 允许的字符里，所以它不会和真实会话重名。

- 每次导入尝试有自己的临时引用。即使几次并发的尝试针对同一个会话、同一份内容，也互不影响。
- 收尾时，先给真实会话建立归属和引用，再释放临时引用。
- 准备、语义写入、会话重复和世界准入失败时，只释放本次尝试的临时引用。它们不会强制删除共享的内容，也不会释放已有会话的声明。之后没人声明的字节可以被生命周期清理回收。
- 新建的会话在媒体收尾时失败的话，创建流程会在会话生命周期锁里删除这个会话并释放它的声明。
- 同步（sync）在提交之后移除明确的引用，归属和字节的回收留给生命周期清理。

出问题时：

- 语义数据已经提交、但收尾失败时，临时引用保留，直到永久的声明可以恢复。会话创建在回滚成功之后释放它；回滚失败也保留它。
- 释放临时引用是尽力而为的。失败只记日志，不改变导入的结果。
- 进程崩溃或释放失败可能留下一条临时引用。在它过期之前，清理会保留它的字节。

> [!NOTE]
> 被遗弃的临时引用在创建满 24 小时后过期。过期的引用只由 `POST /api/media/cleanup` 释放：演练在 `expiredRefs` 里列出它们，真正的清理移除它们。没有定时任务会做这件事，媒体库的删除也不会。
>
> 一次导入只在一个请求里持有它的临时引用，远远短于 24 小时，所以清理不会拿走一次还在进行的导入的引用。这个时限是固定的，不能通过请求或环境变量修改。

## Pictures sent to the story model

除了给玩家显示之外，内核只为一个目的读取图片字节：故事 agent 的模型接受图片输入时，它会收到本会话最新的图片，作为内联的 base64 图片（见 [Prompt 结构参考](./prompt-structure.md#展示过的图片)）。这次读取和玩家读取受同样的限制：

- agent 循环在调用模型之前只持有 `MediaRef`。它依次调用 `lookup()` 取得保存的 MIME 类型和大小，调用 `isReferencedBy(id, sessionId)` 确认会话有权读，然后才 `get()`。会话既不拥有也没有引用的文件不会被发送。
- 只发送 `image/png`、`image/jpeg`、`image/webp` 和 `image/gif`，每张最多 3,750,000 个原始字节。超过上限的图片被略过，内核不会缩放图片。
- provider 层收到的是字节，从来不是位置：媒体 URL、签名令牌、文件路径和 `MediaRef.url` 都不会进入提示词，provider 层也不去下载任何东西。读取失败时记一条警告，这次调用不带那张图片继续进行。
- trace 里保存的是内联数据的长度，不是数据本身。

## Lifecycle Cleanup

**SQLite 连接的归属**

SQLite 媒体工厂在构造成功之前，自己持有共享连接的引用。初始化失败时只释放这一个引用，保留其他持有者，并重新抛出原始错误。成功之后，由返回的 store 的 `close()` 负责释放。最后一个持有者释放时，连接才关闭。

**清理接口：`POST /api/media/cleanup`**

框架提供这个接口，用于手动清理和接入定时任务。

1. 路由用共享的 `collectMediaRefIds()` 扫描：现存的会话、消息、插件数据、runtime 输出、trace 事件、快照、回合结果，以及 `MediaStore.listAssets()` 和 `MediaStore.listRefs()`。
2. 把得到的“受保护 ID 集合”传给 `MediaStore.cleanup()`。

使用这个接口的条件：

| 条件                                                | 不满足时                     |
| --------------------------------------------------- | ---------------------------- |
| 部署不是 `commercial`                               | `503 unavailable`            |
| `demo` 部署带上配置的运维 bearer 令牌               | 在读取开关和策略之前就被拒绝 |
| 设置了 `COVEL_MEDIA_CLEANUP_ENABLED=true`           | `403`，接口默认关闭          |
| `dryRun: false` 时带请求头 `X-Confirm-Cleanup: yes` | `400`                        |

`self` 部署保持本机单用户的行为，不需要令牌。每个会话扫描的行数有上限（`scanLimit`，默认 1,000）。超过时接口拒绝执行，不会悄悄只扫一部分。

**`protectedIds` 只是计划，不是最后的裁决**

- 清理的计划里还包括当前所有的归属和引用声明，包括导入时还没过期的临时引用。所以演练（dry run）会把被钉住的文件报告为受保护。
- 每个后端在删除的同一个临界区或事务里，再检查一次文件当前的归属和引用：PG 用 advisory 事务锁加 `NOT EXISTS`，SQLite 用 `BEGIN IMMEDIATE`，IndexedDB 用跨两个 store 的 `readwrite` 事务，Memory 同步检查 map。
- 所以在路由扫描之后才建立的引用或归属，仍然能保住文件。返回的清理计数和 ID 以实际删除的为准，不是照抄过时的计划。

**SQLite 的额外规则**

- SQLite 持有 `BEGIN IMMEDIATE` 锁，一直到内容文件删除完成。这样一次并发的、内容相同的 `put()` 不可能在旧的删除结束之前把字节重新建出来。
- 删除文件（unlink）失败时，元数据和引用的移除一起回滚。
- 实际的 `delete()` 和非演练的 `cleanup()` 必须在已有的 SQL 事务之外运行。共享连接上已经开着一个事务时，它们在改动元数据或引用之前就拒绝执行。调用方要等自己的 DataStore 事务结束之后再调用它们。原因：文件系统的 unlink 没法被外层的 SQL 回滚撤销。
- 这个限制不适用于 `put()` 和清理的演练，它们可以在 DataStore 事务里使用共享连接。

**清理策略的字段**

| 字段              | 含义                                                               |
| ----------------- | ------------------------------------------------------------------ |
| `dryRun`          | 默认 `true`：只返回删除计划，字节原样保留                          |
| `maxAgeMs`        | 删除创建时间不晚于 `now - maxAgeMs` 的、不受保护的文件             |
| `maxBytes`        | 从最旧的开始删除不受保护的文件，直到保存的总字节数不超过这个上限   |
| `keepRecentBytes` | 保留最新的、这么多字节的不受保护文件，更旧的不受保护文件被选中删除 |

- 空的策略返回一份清单式的演练结果，选中的删除数量为零。
- `expireRefs: { sessionIdPrefix, maxAgeMs }` 只存在于 store 的接口里。它让清理同时释放被遗弃的引用：会话 ID 以 `sessionIdPrefix` 开头、并且创建时间不晚于 `now - maxAgeMs` 的引用。前缀必须包含冒号，否则调用被拒绝：会话 ID 里没有冒号，所以真实会话的引用永远不会匹配。清理接口总是传 `world-data-import:` 和 24 小时。释放的引用列在结果的 `expiredRefs` 里；它不再保护文件，但文件是否删除仍然由其他字段和其他声明决定。
- `onlyIds` 只存在于 store 的接口里，清理接口不接受它。它把策略限制在列出的文件上：其他文件不管别的字段怎么写都保留。媒体库用 `{ maxBytes: 0, onlyIds }` 删除，所以一次删除只能碰到它点名的文件，而且每个文件仍然要通过上面的归属和引用检查。

桌面端和网页端读取媒体时使用同一份权威的 store 元数据。浏览器缓存里的条目先对照 `MediaRef` 校验，再用来显示。

## Media library

玩家在 **设置 → 已存储的媒体** 里查看和删除保存的媒体。它由 `GET /api/media/library` 和 `POST /api/media/library/delete` 提供（见 [api.md](./api.md)）。不在那里确认，就不会删除任何东西。`POST /api/media/cleanup` 仍然是运维用的工具。

**什么算“在用”。** 一次扫描（`apps/server/src/routes/api/media-reference-scan.ts`，和清理接口共用）为每个媒体 ID 算出“当前有哪些会话在用它”。下面任意一条成立，就算这个会话在用这个文件：

- 它是文件的归属者（`recordOwnership`）；
- 它持有一条明确的引用（`addRef`，即 `media_refs` 里的一行）；
- 这个 ID 作为 `MediaRef` 出现在该会话的 `messages`、`plugin_data`、`runtime_outputs`、`trace_events`、`snapshots` 或 `turn_results` 的任何一行里。

由此得到四种状态：

| 状态                 | 含义                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 在用                 | 至少有一个当前的会话在用它                                                                                        |
| **未使用**（unused） | 一次完整的扫描没有找到这样的会话，也没有别的东西声明它                                                            |
| **被占用**（held）   | 它的归属者或引用不是一个当前的会话：正在进行的导入的临时引用 `world-data-import:<uuid>`，或者比会话活得更久的声明 |
| **未知**（unknown）  | 扫描不完整，而这个文件没有找到已知的使用者                                                                        |

扫描什么时候不完整：某个会话的行数超过上限（媒体库是 200,000，可以用 `scanLimit` 参数修改）。这时没有任何文件算“未使用”，删除未使用媒体的请求以 `409 scan_incomplete` 被拒绝。读不出来的会话，永远不会被当成“没有引用的会话”。

**世界里的媒体。** 世界包里的文件（`worlds/<id>/media`、封面、立绘）不在 MediaStore 里，媒体库既不列出也不删除它们。

- 带 `to: media` 的世界数据，会在创建会话时把字节复制进 MediaStore。
- 这个世界的每个会话都声明同一个按内容寻址的文件：第一个会话既是归属者又有引用，之后的每个会话只有引用。
- 删除一个会话只释放这个会话的声明。所以这个文件一直算在用，直到这个世界里持有它的最后一个会话被删掉。
- 一个没有任何会话的世界不需要这份副本：下一个会话会从世界包里重新导入文件。

**成本。**

- 一次列表请求把每个会话的每一行扫描一遍，之后 30 秒内的翻页、筛选和统计都用这次的结果回答。`refresh=1` 会重新扫描。
- 每次删除请求都重新扫描，并丢掉缓存的结果。
- 列表里不带字节。每一项有一个签名 URL，有效期一小时。它的令牌写的范围是 `media-library:`，不是某个会话（冒号不在会话 ID 允许的字符里）。`GET /api/media/:id` 只在媒体库可用的部署里接受这个范围。
- 服务端没有缩略图，所以图片的 URL 返回的是原图。页面一次显示 48 项，图片懒加载，音频和视频只在玩家点开时才加载。

**删除。**

- 未使用的媒体通过带 `onlyIds` 的 `MediaStore.cleanup()` 删除。所以每个后端都会在删除它的临界区里，再检查一遍它的归属和引用。扫描之后才被某个会话声明的文件会保留，并报告为“已跳过”。
- 在用、被占用或未知的文件，只能用带 `force`、并且只点名一个 ID 的请求删除。这时 `delete()` 把它和指向它的所有引用一起移除。
- 用过它的会话保留自己的记录。原来放图片或声音的地方，界面显示“媒体不可用”的占位。插件再次请求同样的生成时，会得到一个新的文件。

**访问。** 媒体库只在“服务器保存的一切都属于同一个玩家”的地方存在：`DEPLOYMENT_TIER=self` 和桌面版。在 `demo` 和 `commercial` 部署下，以及在浏览器私有模式下（生产服务器使用 MemoryStore），MediaStore 里有多个归属者的媒体，又没有按归属者的索引。所以这两个路由都返回 `503 unavailable`，带不带运维令牌都一样。

## Tests

共用的契约测试在 `packages/store/src/contract/media-store-contract.ts`。目前的覆盖范围：Memory、SQLite/local-fs、IndexedDB（通过 `fake-indexeddb`），以及 `DATABASE_URL` 指向一个可以连上的数据库时的 PostgreSQL（`packages/store/tests/media-store.test.ts`）。
