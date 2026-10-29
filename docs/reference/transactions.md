# 事务

这一页说明 Covel 怎样保证“一批写入要么全部生效，要么全部不生效”。它面向改存储后端、改回合提交流程，或者排查“为什么这次写入没有保存”的开发者。写插件不需要读这一页：插件的写入都走 proposal，由内核提交。

要点只有三条：

- 存储接口 `DataStore` 只有一种事务：`withTransaction(fn)`。每个后端都必须实现它。
- 一次执行（一个回合、一次手动运行、一次后台作业）的全部写入放进一个事务里提交。
- 三个后端（Memory、SQLite、PostgreSQL）对外的行为相同，并发方式不同。

世界包的内容摘要随世界记录的 metadata 一起保存，无需新增数据库字段。[包更新检查](./world-data.md#世界记录和世界包)只读文件；恢复操作在世界写锁内替换记录及摘要，不修改已有会话。

世界包文件不在数据库事务里。生成、修订和翻译通过暂存、包预检、目录替换和失败恢复协调文件与世界记录；[API 的写回规则](./api.md#post-apiworldsidtranslate)说明失败时保留哪些内容。

SillyTavern 内容导入复用 ZIP 世界激活：转换和预览只在内存中进行，随后在世界锁内原子落盘、读回预检并创建记录。失败时只清理本次新建的目录。见[世界安装](./world-installation.md)。

## Contract

```ts
interface DataStore {
  /**
   * Run `fn` inside a scoped transaction and return its result. `fn` receives a
   * transaction-bound store view (`StoreTransaction` — every read/write method,
   * minus the tx-control and lifecycle methods). Writes through that view commit
   * atomically when `fn` resolves and roll back if it throws (the error is
   * re-thrown to the caller). No shared/global handle is mutated, so the tx scope
   * is bound to the single `fn` invocation.
   *
   * Required for every DataStore, including test doubles used by the
   * execution finalizer.
   */
  withTransaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}

type StoreTransaction = Omit<DataStore, "withTransaction" | "close"> & {
  /**
   * Run `fn` in a savepoint nested in the open transaction. A throw rolls back
   * only the writes made inside `fn` and rethrows; the enclosing transaction
   * stays open. Provided by every bundled backend's transaction scope.
   */
  savepoint?<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
};
```

用法很简单：把要一起成败的写入放进 `fn`，并且都通过 `fn` 收到的 `tx` 来写。savepoint 是事务里的一个“可以单独撤销的小段”。

### Rules

1. **`fn` 正常返回就全部提交，抛错就全部回滚。** 通过 `tx` 做的写入一起提交。`fn` 抛错时全部撤销，错误原样抛给调用方。
2. **回滚恢复可观察的状态。** 事务回滚之后，每个读方法返回的结果，和事务开始前那一刻相同。之前就有的记录保留原来的身份；事务里做的修改被丢弃。
3. **没有共享的句柄。** 事务的范围只绑定这一次 `fn` 调用。外层的 store 不会停在“事务进行中”的状态，失败的事务不会把 store 卡住。
4. **事务之外的写入立即生效。** 不在 `withTransaction` 里调用的写方法，写完就是持久的。
5. **事务里只能用 `tx` 写。** 在 `fn` 里（包括它 `await` 的代码）通过外层的根 store 调用写方法，每个后端都拒绝，抛 `RootStoreWriteInTransactionError`，什么也不写。错误逃出 `fn` 时整个事务回滚。读方法不受限制。`fn` 结束之后才运行的代码（比如它留下的定时器）不算在事务里，照常写入。
6. **不允许嵌套。** 每个后端都拒绝在事务里再开事务（见[下文](#nesting-is-rejected-on-every-backend)）。需要一段可以单独回滚的范围时，用 `tx.savepoint`：
   - SQLite 在唯一的连接上执行 `SAVEPOINT` / `ROLLBACK TO`。
   - PostgreSQL 打开 Drizzle 的嵌套事务，也就是保留连接上的一个 savepoint。
   - MemoryStore 为每一层打开的 savepoint 保留一份惰性快照。

**消息 ID 不能重复。** 普通的 `addMessage` 插入会拒绝一个已被占用的全局消息 ID，即使占用它的是另一个会话。拒绝不会改动原来那一行。错误逃出事务回调时，之前的写入回滚；失败的 savepoint 只回滚它自己的写入。另一个接口 `commitPlayerInputMessage` 保留它明确的“幂等接管”约定。

**追加型记录的 ID 不能重复。** 回合结果、工具调用、运行时输出、交互记录、状态变化、事件、trace、回合消息、玩家输入和会话摘要的 ID 都是全局主键。在每个后端上，用已有的 ID 再写一次都会报错，原来那一行不变。

**设定条目的批量写入是原子的。** `upsertLorebookEntries` 的一批里只要有一条失败（比如 ID 含 U+0000），整批都不写。

**快照刷新。** 同一个属主刷新快照时，采集时间和内容在同一次写入里更新，并跟随外层事务的提交或回滚。它不改变快照 ID，也不放松对跨会话归属的拒绝。

**一个 ID 只属于一个会话。** 快照、挂起记录（suspension）和世界数据导入账本的 ID 各自只有一个会话属主。

- 用另一个会话的名义 upsert 一个已有的 ID，在每个后端上都抛 `SessionRecordScopeConflictError`，原记录不变。
- SQL 后端在原子的冲突更新里检查归属，并发的首次插入也一样。
- 账本批量写入里只要有一条归属冲突，整批回滚。这个错误也会让外层的 store 事务回滚。

**历史压缩是一个事务。** 通过 `history.compact@2` 做的历史压缩，在一个事务里完成四件事：有选择地删除摘要、插入替换的摘要、给源消息打标记、给属于被替换摘要的消息重新打标记。

- `deleteSessionSummaries` 接受可选的摘要 ID 列表；`retagCompactedTurnMessages` 接受可选的源摘要 ID 列表。
- 空列表不改任何行。省略列表表示选中这个会话的全部摘要，或全部已压缩的消息。
- 压缩器总是传明确的 ID，保留不动的段，并检查提供者生成结果的这段时间里摘要有没有变化。
- 替换一段旧前缀时，保留它最早的摘要 ID 和时间戳。这样只加载“未压缩的原始历史”时用到的排序不变。
- 源消息的原文仍然保存着。
- 任何一次写入失败，整个替换回滚。

### Contract tests

`packages/store/src/contract/store-contract.ts` 运行所有后端共用的行为测试（`contract/suites/integrity-suites.ts` 的 `withTransaction` 组）。每个后端都必须通过：

- `commits all writes when the callback resolves`
- `rolls back all writes and rethrows when the callback throws`
- `returns the callback result`
- `does not swallow writes across concurrent transactions`
- `rolls back only the failing concurrent transaction`
- `rolls back only a failed savepoint and keeps the enclosing transaction`
- `rolls back savepoint writes with the enclosing transaction`
- `does not expose writes through the root store before the transaction settles`
- `rejects a nested withTransaction with a clear error instead of deadlocking`
- `recovers and accepts a fresh withTransaction after a nested rejection`

`contract/suites/plugin-data-suite.ts` 另外检查操作式写入依赖的读改写：同一事务里写入后能读回，失败的 savepoint 里的写入之后不可见，嵌套值原样往返。

新增的存储后端**必须**通过这套测试。

## Versioned plugin-data batch CAS

带版本的领域记录用一个由宿主持有的 `PluginDataStore` 原语来写。CAS（compare-and-set）的意思是“先比对版本，全部对得上才写”。根 `DataStore` 和事务内的视图上都有这个方法：

```ts
compareAndSetPluginDataBatch(
  sessionId: string,
  pluginId: string,
  records: readonly {
    namespace: string;
    key: string;
    expectedVersion: number | null;
    value: unknown;
    timestamp: string;
  }[],
): Promise<boolean>;
```

- `expectedVersion: null` 要求这条记录不存在。正整数必须和现有 JSON 记录的 `value.version` 完全相等。
- 所有比对都通过之后，才改动任何一行。
- 有冲突时返回 `false`，什么都不写。
- 条目无效、`(namespace, key)` 重复，或者基础设施故障，会抛错。
- 外层事务仍然负责回滚其他所有写入。
- 它不是一张新表，不是通用的 JSON 合并 API，也不是写其他插件分区的许可。

每个后端都要求父会话存在，即使是用作写屏障的空批次。会话不存在或已删除时，抛 `SessionNotFoundError`（`code: session_not_found`），不会留下没有归属的行。

各后端的做法：

- **Memory**：在它串行化的 store 边界里比对并替换整批。
- **SQLite**：自己持有事务时用 `BEGIN IMMEDIATE`。调用方已经开了事务时复用它，不嵌套。
- **PostgreSQL**：在事务里先用 `FOR UPDATE` 锁住父会话行，再比对和写入。这把锁一直持有到调用方写完账本和回执。“先读再普通 upsert”，或者只靠进程内的会话锁，都不算 CAS。
- **BrowserVault**：保留它现有的原子 checkpoint / revision 约定，不是 `DataStore` 的 IndexedDB 实现。checkpoint 里保留已采用的维度记录、版本、来源引用和结算回执。

维度的初始化、更新和导入都使用这个原语。

- 共享的 schema / value 校验器在提交边界再运行一次。
- 通用的 `plugin.data`、batch、delete 路径不能写 `_dimensions` 或 `_dimension-settlements`。
- 所有读过的版本都必须仍然匹配，结算才算成功。评估过但值没有变化的维度也包括在内。

### Dimension settlement and execution atomicity

**登记义务。** 宿主在已提交叙事的那个事务里登记一项结算义务，使用权威的 result ID 和逻辑回合号。

- 冻结的定义和读取时的版本保存在回执里。
- 叙事正文从源回合的 artifact 读取，不复制到每张回执里。
- 更新后的值和成功回执在同一个 CAS 批次（同一个事务）里提交。
- 明确的 `no-change` 同样校验读取集并写一张回执。它不能从“没有工具调用”或“runtime 成功了”推断出来。

**初始化只有一条写入路径**：它自己的 `dimension.initialize` proposal。

- 它和其他 proposal 一样经过 `PreStateCommit`，并在提出它的 runtime 的 savepoint 里提交。
- 所以：被否决就什么都不写；被改写就写入改写后的定义；runtime 被丢弃时，它的初始化也一起丢弃。
- 在任何 runtime 提交之前，`finalizeExecution` 只把会话绑定到它的维度提供者。

**回执冻结已提交的记录。**

- 回执在提供者 runtime 第一次需要它的地方登记（它的第一次结算更新之前），最后一个 runtime 之后再登记一次。
- 在一个回滚了的 savepoint 里登记的回执，会根据真正提交的内容重新登记。
- 没有任何已提交的维度带规则时，不登记回执。

**计划被拒绝时。** 被拒绝的跟踪计划可以保留故事，并留下一个明确的 `pending-settlement` 领域结果：不写任何值，也不写成功回执。

- 这**不**改变 `finalizeExecution` 对待 `committed:false` proposal 的方式：执行里有已提交的故事时，丢弃提出它的那个 runtime；否则回滚整个执行。
- 普通的手动版本冲突仍然是写入被拒绝。基础设施错误仍然抛出并回滚。
- 通知只在持久提交之后发布。
- 下一次叙事被阻止，直到待结算的来源被重试、被明确标记为 `manual`，或被明确标记为 `skipped`。单纯改一个值不能解决它。

**快照和恢复。** 回执和已采用的定义 / 值沿用现有的快照、fork 和浏览器 checkpoint 路径。已经终结的来源在恢复或重试之后不会再结算一次。五种状态见 [World Model](./world-model.md#回合时序与结算回执)，editor / tracker RPC 的边界见 [API](./api.md#维度编辑与待结算恢复)。

> [!NOTE]
> 旧的 raw dimension 世界，以及开发期的会话和 checkpoint 必须重建。没有旧格式读取，也没有“维度到 lorebook”的双写。

## Backend implementations

先说两条对所有后端都成立的提交前提。

**否决或取消。** 准备好的提交计划里记录了执行被否决或被取消时，最终提交在进入领域事务之前就被拒绝。

- 调用方的 `extraInTx` 写入、缓冲的 proposals、journal 条目、suspension、exports、快照和成功的完成事件都不发生。
- 之前已经记录的执行历史结算为 failed。
- 已经持久化的客户端输入不在这条边界之内。

**故事必须完成。** 故事完成是提交的前提。下面三种情况会在任何缓冲的 proposal、journal 消息或玩家回合计数提交之前，拒绝整次执行的提交：

- `outputKind: story` 的 runtime 失败了。
- story 的结果成功了，但清理后的 `narrativeOutput` 为空。
- 维度提供者在同一次执行里失败，执行器因此扣住了故事（`dimension-snapshot-unavailable`）。

相关的规则：

- 故事因为其他原因被跳过（它的 guard，或声明的门控）时，不拒绝执行。
- 已经持久化的客户端消息不在这个事务里。
- story runtime 不会被提供 `runtime-done`。模型出于习惯调用它时，框架先用剩下的有限步数向它要叙事；结果仍然为空，就算 runtime 失败。
- 这不会重试或撤销外部工具已经产生的副作用。
- 可选的系统提取器在一段有效的故事之后仍然可能失败。它们的失败不会丢弃故事。

### MemoryStore

用两阶段快照实现。快照是每个集合的**浅引用拷贝**（`new Map(value)` / `[...value]`），不是深拷贝。

- 事务在第一次写某个集合时才惰性地拍下它。哪个方法碰哪个集合，由 `WRITE_METHOD_TOUCHES` 里的映射决定。不认识的写方法保守地拍下全部集合。
- 回滚时把拍下的集合原地恢复，所以调用方手里已有的引用仍然有效。
- 提交时直接丢弃影子拷贝。
- 文件：`packages/store/src/memory/transaction-methods.ts`

> [!IMPORTANT]
> 正确性依赖于记录被当作**不可变**的：修改必须替换记录（新对象），不能原地改。所以 O(行数) 的引用拷贝是安全的。在“不原地修改”的约定下，深拷贝没有必要，而且贵得多。

### SqliteStore

直接执行 SQL：`sqlite.exec('BEGIN')` / `'COMMIT'` / `'ROLLBACK'`。

- store 是一个同步的 `node:sqlite` 连接。所以 `withTransaction` 用一条 promise 链把并发的调用**串行化**：每个调用跑完自己完整的 BEGIN…COMMIT，下一个才开始。谁的写入都不会丢。
- 文件：`packages/store/src/sqlite/sqlite-transactions.ts`

### PgStore

`postgres.js` 是连接池。裸的 `unsafe('BEGIN')` 不会绑定到某一个具体的连接上。

- `withTransaction` 使用 Drizzle 原生的 `db.transaction(async (tx) => …)`。它为回调保留一个专用的池内连接，并正确地发出 BEGIN / COMMIT / ROLLBACK。
- 事务范围内的 store 视图把每次写入都发到这个连接上。所以并发的 `withTransaction` 调用跑在各自独立的连接上，是真正并行的事务。
- 文件：`packages/store/src/postgres/pg-store.ts`

### Cross-backend semantics (read before adopting)

三个后端遵守同一份可观察的约定（原子提交 / 回滚，拒绝嵌套），但并发和隔离方式不同：

| 后端                          | 并发模型                                                                                         | 回调进行期间，根 store 上的并发操作                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **PgStore**                   | 每次调用跑在**自己的池内连接**上（Drizzle `db.transaction`），是真正并行的事务。                 | 读操作看到的是各自的数据库快照；写操作留在各自的连接上，不会被并进这个事务。               |
| **SqliteStore / MemoryStore** | **单个连接 / 单份实时状态。** 事务和根 store 的每次读写共用一个 promise 队列（**串行操作门**）。 | **排队，直到事务结束**：没有脏读，写入也不会被并进事务。通过 `tx` 发出的操作仍然就地执行。 |

#### 串行操作门（SQLite / Memory）

只有一个连接或一份实时状态时，事务自己做不到隔离。没有这道门，事务打开期间别处发出的写入会落进这个事务，外面的读操作也可能看到之后被回滚的数据。

会话锁只给同一个会话的回合写入排序。它是按会话的，而且有些路由根本不持有会话锁（世界导入、角色编辑、设置）。所以另一个会话的写入可能凭空消失。

`packages/store/src/serialized-write-gate.ts` 把事务和根 store 的全部操作放进**同一个队列**：

- 事务外面的读写等事务结束。
- 通过 `tx` 范围发出的操作就地执行。它属于这个事务，让它排队会造成死锁。
- 事务回调里通过根 store 发出的读就地执行；`DataStore` 的写被拒绝（规则 5）。共用这个连接的镜像 MediaStore 不受规则 5 限制，它的写仍然就地执行。
- “里面还是外面”由 `AsyncLocalStorage` 判断。所以一个真正并发的调用方，即使在事务停在某个 `await` 时开始，也不会被误认为是嵌套调用。

**这道门按连接设，不按 store 设。** 所有通过同一个 `node:sqlite` 句柄做修改的代码共用一道门，由 `sqlite/shared-connection.ts` 里的 `getConnectionWriteGate(db)` 取得。共用它的有：

- `DataStore` 的方法；
- 可选的 sqlite-vec 能力（`VECTOR_WRITE_METHODS`）；
- 有意复用同一个连接的镜像 MediaStore（`MEDIA_WRITE_METHODS`）。

如果向量或媒体的写入不经过这道门，另一个会话发出的这类写入会并进一个打开的事务，并随它的回滚一起消失。

**事务体里只做存储工作。** 语句本来就是串行的（`node:sqlite` 是同步的），但这道门在事务的整个回调期间都被持有，包括其中的 `await`。出于这个原因，执行的最终提交先运行插件的 `PreStateCommit` hooks，再打开事务。

**每个事务一个连接（像 PgStore 那样）仍然是真正并发的长期答案。** 这道门在不重做存储连接结构的前提下，补上了正确性的缺口。回归测试：`packages/store/tests/serialized-write-gate.test.ts`。

### Vector index initialization and transfer

**初始化。** 注册了的向量模型保证它的物理表存在。

- PostgreSQL 在一个事务里初始化注册表行、可选的 vector 扩展、表和索引，提交之后才发布进程内的缓存。一把 advisory 事务锁让多个进程的初始化排队。
- SQLite 使用 immediate 事务，并直接读取模型状态。所以外层的回滚不会留下过期的缓存。
- 已经损坏的开发期注册表必须重建。

**不随会话转移。** 快照、fork 和浏览器 checkpoint 的传输都不包含保留的 `__kernel:vector` 分区。

- 它的摄取游标和哈希描述的是本机的一份物理索引，不是可以转移的会话数据。
- 导出方和导入方都执行这条规则。重建出来的会话重新索引自己的消息和 lore。
- 名字相同的普通插件数据 namespace 照常保留。

**什么时候摄取。**

- 服务端共享的提交入口只在 `commitExecution` 报告已经持久提交之后，才安排尽力而为的摄取。玩家回合、手动执行、恢复的执行和后台（detached）执行都走这个入口。
- fork 和浏览器 checkpoint 替换之后也安排摄取。
- 启动（bootstrap）时，先在摄取租约里确立配置的 embedding 模型锁，再读取语料。
- 一次已安排的运行按有界的服务商批次持续进行，直到当前语料索引完。返回数量不足或失败的 embedding 把未完成的进度留给下一次运行。

**锁。**

- 摄取使用它自己的按会话的锁（跨 PostgreSQL 主机时是 advisory 锁），从不使用回合锁。
- 生命周期里的替换和删除按这个顺序取锁：会话 → 需要时的世界 → 摄取 → 存储事务。
- 它们等所有延迟的向量、游标更新、哈希更新和归档删除完成，再替换或删除状态。保留 `createdAt` 的 checkpoint 也一样。
- 重建记忆索引（[`POST /api/sessions/:id/memory-index/rebuild`](./api.md#post-apisessionsidmemory-indexrebuild)）也在摄取锁里换模型：先等进行中的摄取结束，换好之后再安排新的摄取。
- embedding 运行期间，普通回合可以照常提交。摄取器会合并出下一趟来读到这些提交。
- 关闭时先排空被跟踪的记忆任务，再关闭存储。
- embedding 失败不改变已提交回合的结果。

**fork 保留角色 ID。** 每个后端都用 `(sessionId, id)` 作角色的键。所以复制过去的插件引用和子会话的快照，指向的角色和子会话 store 里的相同。

### MediaStore transaction and concurrency fixes

媒体的生命周期修改，在 DataStore 事务之外，另有按资源的原子性：

- **SQLite / local-fs**：清理时，最后一次属主 / 引用检查和资源删除放在 `BEGIN IMMEDIATE` 里完成。它的 MediaStore 共用 DataStore 的连接门，所以并发的事务不会在回滚时吸收或弄丢一次媒体写入。清理只报告真正删除了的资源。
- **PostgreSQL**：`put`、归属、引用、删除和清理操作使用以内容 ID 为键的事务级 advisory 锁。它让“先写者胜”以及引用和删除之间的竞争在多个进程之间排队。清理还在带保护的删除语句里使用 `NOT EXISTS`。
- **IndexedDB MediaStore**：在它的 object-store 事务里保持归属和引用更新的原子性。它只是一个媒体后端。浏览器里游戏状态的持久化由下面的 [BrowserVault](#browservault-transactions) 负责，不是一个 IndexedDB 版的 DataStore。

### Nesting is rejected on every backend

在一个 `withTransaction` 的回调里再调用 `withTransaction` 是编程错误。三个后端都**同步地拒绝它，并给出清楚的错误**：

- **串行的后端（SQLite / Memory）**：内层调用会在串行链上排到外层事务的后面，而外层又在等内层。这是永久的**死锁**。守卫把这种无声的卡死变成一次立即的拒绝。
- **PgStore**：嵌套不会死锁（连接是独立的），但内层调用会作为一个**单独的、不具原子性的事务**运行：外层回滚撤销不了内层的提交。为了约定统一，也为了避免这种无声的意外，同样拒绝。

错误信息：`"<Store>: nested withTransaction is not supported on the
<backend> backend; <reason>. Flatten the nested call, or perform the inner
writes directly through the outer callback's tx scope."`

#### How nesting is detected

SqliteStore、MemoryStore 和 PgStore（都在 Node 上）用同一种办法：

- 一个 `AsyncLocalStorage` 作用域（`packages/store/src/tx-nesting-guard.ts`）标记正在运行的回调的异步上下文。
- 进入新的 `withTransaction` 时同步检查 `isNested()`。只有重入（嵌套）的调用返回 `true`；独立的并发调用方返回 `false`。所以正当的并发不会被误报。
- 共用的错误构造函数在 `packages/store/src/tx-nesting-error.ts`。
- 这个守卫只在 Node 上有，因为所有 `DataStore` 后端都运行在服务端。

## BrowserVault transactions

浏览器私有的持久化有意放在 `DataStore` 之外。IndexedDB 的事务和 schema 生命周期由 Dexie 管理，代码在 `apps/web/src/services/storage/browser-vault.ts`。

新存档的第 1 版就是服务端的第一份导出（见[浏览器私有工作区](./api.md#浏览器私有工作区)）：服务端先创建并初始化会话，浏览器再把导出的完整 checkpoint 原子保存为插件集合、开局状态和世界数据，不分开保存各个领域。第一份导出失败时不保存任何本地存档，并尽力删除服务端会话。

**写入。**

- 一份 checkpoint 和它那条紧凑的“动作幂等”记录在同一个 `rw` 事务里提交。
- 只保留最新的一份完整 checkpoint。
- `baseRevision`、`revision` 和 `actionId` 用来拒绝过期的或走岔了的写入。
- 世界编辑和本地 checkpoint 写入使用当前的浏览器世界记录。所以一份较旧的会话 checkpoint 不能撤销一次已保存的编辑。

**删除。** 删除一个浏览器世界时，原子地移除它关联的 checkpoints、提交元数据和待定提交。它拥有的会话镜像尽力清理，不会删除服务端共享的世界。

**上传和下载。**

- 浏览器 checkpoint 的上传和下载由 `LocalDataService` 串行化。在补水（hydration）或暂存另一个动作之前，它负责恢复持久化的待定提交。
- 临时会话不存在时，清除待定标记，并允许从浏览器 checkpoint 重建。其他错误保留标记，并阻止更新的提交。
- checkpoint 导出读 `listTurnResults(sessionId)` 与 `listRuntimeOutputs(sessionId)`，只保留最近 40 个执行（`JOURNAL_EXECUTION_WINDOW`）的行；被中断而没有 turn-result 行的执行不随检查点保存。
- 上传和提交路由在使用 revision 或幂等缓存之前，在会话锁内重新检查属主、incarnation 和删除状态。缓存条目属于一个 incarnation；同一个 ID 被重新创建之后，旧条目被丢弃。

**导入和替换。**

- 用 checkpoint 替换一个会话时，临时的服务端工作区使用 `MemoryStore.withTransaction`。
- checkpoint 导入在进入写事务之前，校验每条记录的结构和会话范围，包括快照的内容。
- 受信的 fork 复制用 `rebindSnapshotPayloadSession` 把嵌套的状态绑定到子会话。导出在做传输校验之前，先规范化旧的 fork 内容。外部的 checkpoint 输入永远不会被重新绑定来绕过归属检查。
- `replaceSessionFromCheckpoint` 默认保留全局的世界。调用方必须先独立地授权全局写入，再明确选择 `writeWorld`。只拥有会话，并不授权更新共享的世界。

这是一份同步约定，不是要在浏览器里重现完整的服务端事务 API。

## Kernel integration

事务边界有两层：

- **`commitAll`**（`packages/runtime/src/commit/session-commit-pipeline.ts`）把**单个 runtime** 的一串 proposal 提交进一个 `withTransaction` 回调。它是最底层的提交原语。
- **`finalizeExecution`**（`packages/runtime/src/commit/finalize-execution.ts`）把**整个 execution** 的所有 runtime 一起包进**一个** `withTransaction`。“整个 execution”指顶层结果，加上拍平后的嵌套 `recursiveCall` 结果。嵌套结果只在父 handler 成功时进入，排在父结果之前（子先于父）。

谁来调用：

- 三个提交拥有方（`actions.ts`、`plugin-rpc/runtime-turn.ts`、`resume.ts`）把公开执行入口返回的 `{ result, commit }` 整体交给 `commitExecution({ execution, ... })`。
- 提交计划记录了执行时的 schema、Hook 设置、journal、suspension 和嵌套结果。宿主不再重新加载 schema，也不手工组装这些字段。
- 已声明的导出缺少 schema 时，整次事务失败。
- `commitExecution` 进入这条边界，再由同一个宿主入口协调通知、快照和记忆调度。

**`loreOverride` 不在回合事务里。** `start_session` 带 `loreOverride` 时，服务端先把它写进会话 metadata，再进入回合事务。所以随后的回合失败不会撤销这次写入。这是有意的：后续回合和其他实例看到的是同一份世界背景快照。

**`/api/actions` 的收尾。** `onFinalized` 只根据持久化的结果（durable outcome）结算宿主标记，并把它放进观察队列，不等 SSE 被消费。自动 snapshot 仍然在同一把 session lock 里执行。

- 写入错误、队列溢出、观察截止和锁外 drain 失败，都不能把已提交的 artifact 改成 failed，不能开放同一回合的恢复重放，也不能重试模型。
- 恢复以持久化的 artifact 和只读的 execution / session 端点为准，不看是否收到了最后一帧。

### 回合级单事务

`finalizeExecution` 把整回合所有 runtime（含嵌套 `recursiveCall` 结果）聚合进单一事务。下面逐条说明它的行为。

**叙事优先的失败边界。**

- 领域写入抛出的 store 错误，使整回合回滚。
- handler 校验失败返回的 `{ committed: false }`（如 PreStateCommit veto、缺字段的 plugin.data），在本次执行有成功的 story 结果时，只回滚提出它的那个可选 runtime。
- 做法：每个非 story、非 setup 的顶层 runtime 连同它下面各层的嵌套 `recursiveCall` 结果，组成一个提交单元，在一个 savepoint 里提交（子先于父）。单元里任何一条写入被拒，整个单元一起撤销，叙事和其他单元照常提交。含有 story 或 setup 运行的单元（哪怕是嵌套运行；setup 按 manifest 的 stage 判断）直接在执行事务里提交：其中任何写入被拒，整回合回滚。被丢弃单元里的挂起不保存。保存下来的挂起，它扣住的 detached 作业按丢弃结算：硬依赖被丢弃 runtime 的作业去掉，其余作业在冻结输入里把它记为 `failed`。本次执行的挂起全部被丢弃时，回合像挂起被放弃一样结束：计数，扣住的 detached 作业按同样规则结算后排入。
- 这时 `FinalizeExecutionOutcome` 以 `committed` 返回，并在 `failedProposals` / `isolatedRuntimes`（`{ runtimeId, runId, error, cause }`，被丢弃单元里的每次运行一条）里列出被丢弃的部分。同一个 runtime 可能既嵌套运行又在顶层运行，所以按 `runId` 区分；journal、触发计数和已保存的 `turn_results` 条目也按运行结算。主回合用 `proposal.failed` 和该 runtime 的 `runtime.failed` SSE 告知客户端。
- 没有 story 的执行（manual、background、detached、setup）仍然是整体原子的：任何一个 proposal 失败就整体回滚。作业不会为没有落库的写入报告成功。
- 结果里无法变成 proposal 的 effect 条目，同样算作该 runtime 被拒绝的写入，按上面的边界处理，不会以异常拖垮整回合。这类条目是：`effects.ui[].parts`、`effects.interactions`、`effects.notifications` 里不是对象的条目，以及后两个通道里不是数组的内容。function runtime 在 handler 返回时就以 `output-schema-invalid` 失败。在会提交写入的结果中，已移除的 `effects.statePatches` 通道也会被拒绝，错误信息会指引作者改用插件数据。它以 `effects.invalid` 诊断标记报告，不冒充某一种 proposal。

**导出发布有独立的失败边界。**

- 每个 `recordAs` export 的读取、序号分配和追加放在一个 savepoint 里。
- 单个 export 的存储失败先回滚这个 savepoint，再记录诊断，然后继续其他 export 和领域提交。这样 PostgreSQL 不会把一个已被捕获的 SQL 错误留在中止的事务里。
- 缺少声明的 schema，以及公共输出契约校验失败，仍然在正常的执行校验边界处理。

**只有上游真正提交，下游才提交。** 提交单元按执行顺序提交。被丢弃 runtime 的硬依赖方一起丢弃（`commit/commit-dependencies.ts`）。依赖只在顶层 runtime 之间检查：嵌套结果只依赖同一次嵌套执行里的结果，它们在同一个单元里，随单元一起提交或丢弃。

| 关系                                              | 上游被丢弃时                              |
| ------------------------------------------------- | ----------------------------------------- |
| turn 作用域的 `needs` 目标                        | 下游一起丢弃                              |
| 必填 `inputs` 的来源                              | 下游一起丢弃                              |
| 事件订阅者，触发它的事件的全部发出者都被丢弃      | 订阅者一起丢弃                            |
| `after`、`required: false` 的输入                 | 不级联，它们只表达顺序或尽力读取          |
| `cardinality: one` 的能力依赖，另有提供者提交成功 | 仍然满足                                  |
| story 或 setup runtime 的硬上游                   | 整回合回滚                                |
| 读取了它未提交的插件数据（辅助单元）              | 下游一起丢弃                              |
| 读取了它未提交的插件数据（story 或 setup 单元）   | 照常提交，trace 记 `read-dependency.kept` |

**读取依赖。** 同一次执行里，runtime 读自己插件的数据时能看到同插件上游 runtime 还没提交的写入（见[执行内的插件数据可见性](./plugins.md#执行内的插件数据可见性)）。每次读取记下它实际看到了哪些上游的写入（`read-dependencies.ts`），执行把这些依赖带进提交计划。

- `get` 只依赖还影响返回值的上游。runtime 自己先整体写了这个键（`set`、删除，或含有其中之一的操作列表）再读，就没有依赖。
- `list` 依赖写过这个 namespace 的全部上游。不带 namespace 的列表依赖写过插件数据的全部上游。
- 提交时，辅助单元里任一成员读过单元外、已被丢弃的上游，这个单元就一起丢弃，错误是 `read data of <上游 runtime> that did not commit`。
- 它和硬依赖共用同一个丢弃集合：它的硬依赖方、读过它的写入的 runtime、`extraInTx` 和挂起保留的作业都把它当作被丢弃。
- story 或 setup 单元不因读取依赖丢弃。每个被丢弃的上游在同一个事务里写一条 `read-dependency.kept` trace，载荷是 `runtimeId`、`runId`、`producerRuntimeId`、`producerRunId` 和 `reason`。
- 生产者总是排在读者前面。依赖指向提交顺序更靠后的 run 是内核错误，只记警告并忽略。

`extraInTx` 的第二个参数给出被丢弃的 runtime。主回合据此不排入依赖它们的 detached 作业和后台事件 follower。仍然排入的 detached 作业，在冻结的 turn digest 和上游结果里把被丢弃的 runtime 记为 `failed`。

**PreStateCommit 在事务外运行。**

- finalize 先完成规范化、守卫和 PreStateCommit Hook，再开启事务。事务里只做写入。`createCommitPipeline().commitAll` 同理。
- Hook 不读取存储状态，提前运行不改变语义。好处是插件 Hook 的等待不再占用 SQLite / Memory 的串行门。

**玩家停止和提交共用一条边界。**

- `finalizeExecution` 接受可选的 `signal`。它在事务开始、处理结果和返回之前检查取消，并把信号传给每个提案的 `PreStateCommit` Hook。
- 取消会立即结束 Hook 的等待，停止后续的提案，并整体回滚。
- 主回合传入玩家的控制信号。即使剧情已经生成，取消发生在后处理或提交 Hook 里，事务仍然整体回滚。
- 数据库已经提交之后的通知和 `PostStateCommit` Hook 不继承这个取消信号，按自己的超时完成收尾。

**对话日志和提交同成败。**

- 当前玩家输入，以及非 manual runtime 的 `TurnMessage`，在执行期间只缓存在内存里的 journal。所有 proposal 通过之后，才由 `finalizeExecution` 在同一个事务里 append。
- 回滚了的执行不会进入后续的 Prompt、trigger 统计或 compaction。
- `actions.ts` 同时通过 `extraInTx` 提交 REST messages 镜像和 player InteractionRecord。所以刷新页面和观测面也不会留下已回滚的输入。
- manual / background 路径继续遵守各自“不追加对话历史”的约定。

**`commit_status` 的结算。**

- 成功时，`turn_results.commit_status` 在同一个事务里结算为 `committed`。回滚时，在事务外幂等地结算为 `failed`。
- 嵌套的 recursiveCall 复用顶层的 `turnId`。所以对顶层 `[turnId]` 的一次结算就覆盖了所有嵌套的行。
- `committed` 结算同时把被丢弃 runtime 在 `runtimeResults` 里的记录改成 `failed`，并写入原因。历史、重试和刷新看到的都是实际保存的结果。它们上报的 job 也收尾为 `failed`。
- 和其他失败的 runtime 一样，被丢弃的 runtime 不写入对话日志（文本、交互和 UI 卡片），也不计入触发台账（`maxTriggerCount` / `cooldownTurns`）。

**完成屏障仍被扣留。** 任何一处失败时，`turn.completed`、回合后的记忆摄入和 auto-snapshot 都不触发。每个失败的 proposal 发出一个 `proposal.failed` 事件。回合对客户端呈现为可见的未完成状态，而不是“成功但状态缺失”。

**外部可见的通知在 COMMIT 之后才发。** 外部可见的 fan-out（emitter 事件加 PostStateCommit hook）在事务打开期间缓冲，COMMIT 之后才按顺序发出。回滚时连缓冲一起丢弃。客户端绝不会看到已回滚写入的 “committed” 事件。

**resume。**

- runtime 在进入提交前失败时，只记录自身故障的熔断计数并释放 claim；不提交缓冲写入，不解决或清空 suspension。
- resume 通过 `extraInTx` 把助手的回合消息和 suspension 的 resolved 标记放进同一个事务。任何一处失败，连同 proposal 一起回滚；claim 释放之后可以重试。
- resolved 标记同时清掉这条 suspension 里已被本次 resume 用掉的内容（消息、已缓冲的工具调用和 proposal、输入），只留执行标识、挂起时的玩家回合数和插件版本、语言和回合号。回滚时这些内容随事务恢复。
- 放弃、过期和作废走同一个出口：删除 suspension、给回合计数（它是这个逻辑回合最后一个还在等待的 suspension 时）、把回合扣下的 detached 作业入队，都在一个事务里。

**会话时钟写入进同一事务。**

- 玩家路径（`actions.ts`）通过 `sessionClock` 参数，把两件事放进“proposal 提交之后、`commit_status` 结算之前”的同一个事务（`commit/session-clock.ts` 的 `applySessionClockTx`）：
  - 逻辑回合计数：`completedPlayerTurns` 通过 logical-turn ledger 幂等地推进。
  - setup 阶段的翻转：`phase: setup → playing`，以及 `setupRuntimes` 镜像。
- API 和 snapshot 直接保存当前的（current-only）时钟字段。
- 整回合回滚时（story 或 setup 失败，或者没有 story 的执行里任何一个 proposal 失败），计数、phase 和 setup 镜像都不推进，ledger 不写入。
- 只丢弃可选 runtime 的提交，照常推进时钟。
- manual / background 的 finalize 不传 `sessionClock`，时钟不动。
- resume 会传入。同一个逻辑回合的最后一个 suspension 恢复、被放弃、过期或作废时计数一次。被恢复的是 setup runtime 并且它报告完成时，`done` 镜像和（全部 setup 都完成时的）phase 翻转随这次提交写入；attempt 账本沿用挂起时的那次尝试。

**Action 级 plugin-rpc 的锁边界。** action handler 在 session lock 里完成读、校验和写入。所以它不会和同一个 session 的回合穿插。PG 多进程部署也由同一个分布式锁键串行化。

**交互回答和后续回合。**

- `submit_actions` 里回答交互的行动在回合的 session lock 里校验，并确认它还没有被回答过。然后用一个 store 事务写入批量的 player input 和后续回合的 `turn.started`。
- 所以回答落库和回合开始同成同败。重复提交在锁里看到已有的回答而被拒绝，不会出现“回答已保存而回合没有开始”的状态。
- 回合自己的结果仍然由 `finalizeExecution` 提交。它失败时回答保留，回合经现有的重试再跑。

**必需事务。** `finalizeExecution` 要求完整的 DataStore，直接调用 `withTransaction`，没有“无事务提交回合”的降级。底层的 `commitAll` 收到 `StoreTransaction` 视图时不再开嵌套事务，而是复用调用方的事务。这个分支不代表完整的 DataStore 可以省略事务实现。

**fork 是另一回事。** fork（`snapshots.ts`）是独立的会话重建事务：它重放快照，**不提交任何 proposal**，所以不经过 `finalizeExecution`。两者共用“一个 `withTransaction` 包住整个写入序列”的模式，但是不同的关注点。

```ts
// finalizeExecution: normalization, guards and PreStateCommit run first.
const prepared = new Map();
for (const result of results) {
  prepared.set(
    result,
    await prepareRuntimeProposals(
      result,
      store,
      sessionId,
      kindOf(result),
      opts,
    ),
  );
}
// All runtime results then share one required transaction, which only writes.
await store.withTransaction(async (tx) => {
  // A unit is a top-level result preceded by its nested results.
  for (const unit of units) {
    const commit = async (sink) => {
      for (const result of unit.members) {
        const { proposals, failedProposals } = prepared.get(result);
        const out = await commitPreparedProposals(
          proposals,
          sink,
          sessionId,
          result,
          opts,
        );
        const failed = [...failedProposals, ...out.failedProposals];
        if (failed.length > 0) throw new ProposalCommitFailure(failed);
      }
    };
    // An optional runtime beside a committed story commits with its nested
    // results in one savepoint; a ProposalCommitFailure there drops the unit.
    await (isolates(unit) ? tx.savepoint(commit) : commit(tx));
  }
  for (const message of journalMessages) await tx.appendTurnMessage(message);
  await extraInTx?.(tx, { droppedRuntimeIds });
  for (const turnId of turnIds) {
    await tx.setTurnResultCommitStatus(
      sessionId,
      turnId,
      "committed",
      droppedRuntimes,
    );
  }
});
// Flush buffered notifications only after COMMIT; discard them on rollback.
```

### 操作式写入（plugin.data.update）

插件可以对一个插件数据键提交一串操作，而不是先算好的整个值。function runtime 调用 `ctx.pluginData.update(namespace, key, ops)`；工具用 `makeProposal(ctx, now, "plugin.data.update", { namespace, key, ops })`。操作的种类和语义见[插件数据操作](./plugins.md#数据集contributesdatasets)里的 `ops`。

**在提交事务里读改写。** 提交时，`plugin.data.update` 的处理器在提交事务里读出这个键当前存的值，用 `applyDataOps` 依次应用这些操作，再把结果写回：

- 结果是“不存在”（比如最后一个操作是 `delete`）时，有行就删掉，没有行就什么都不做，提交照样成功。
- 结果存在时，先把**结果**里的每个 `MediaRef` 按会话校验并规范化，再按单个值的大小上限检查结果，再按数据集规则检查（见下），然后写回。提交前的载荷检查只看到操作本身，而引用可能由多个操作拼出来，或者由操作改写已存的值得到，所以结果要再查一遍。改写保留原来那一行的 ID 和 `createdAt`。
- 执行中的覆盖读（runtime 读自己还没提交的写入）用同一个 `applyDataOps` 投影这些操作。所以 runtime 读到的值，和提交存下的值一致。

**每个 proposal 全有或全无。** 一串操作里任何一个失败，整个 proposal 被拒，这个键保持原样。被拒的 proposal 按上面的提交单元规则处理：有成功 story 时只丢弃它所在的可选单元，没有 story 的执行整体回滚。处理器不会为数据问题抛异常；只有 store 错误会抛出，并像其他写入一样回滚整次执行。

**错误码。** 被拒时 `CommitResult.code` 是下面之一：

| `code`                                                                | 原因                                                                                            | `error` 的样子                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `data-op-rejected`                                                    | 操作作用在当前值上失败，比如 `inc` 越过 `min`                                                   | `plugin.data.update: inc result is outside the allowed range (op 0, out-of-bounds)`，有路径时写成 `(op 1 at /gold, …)` |
| `dataset-violation`                                                   | 违反了声明的数据集：操作种类不允许、结果不符合记录 schema，或数据集的 schema 文档缺失、无法编译 | `plugin.data.update: dataset inventory: operation kind append is not allowed`                                          |
| `media-not-found` / `media-ownership-invalid` / `media-mime-mismatch` | 结果里的 `MediaRef` 指向不存在的资源、本会话没有引用的资源，或 MIME 类型不符                    | `plugin.data.update: session … has no reference to media …`                                                            |

缺少 namespace / key、空的或不合法的操作列表在处理器之前就被载荷检查拒绝，`code` 是 `proposal-invalid`。保留命名空间和超过大小上限的拒绝发生在处理器里，没有 `code`，只有 `error`。

**数据集检查。** 插件在 `contributes.datasets` 里声明了某个命名空间时，这个插件写入该命名空间的**每一种**插件数据 proposal 都要检查：

- `plugin.data.update` 里每个操作的种类都必须在数据集的 `ops` 里。整值写入（`plugin.data` 和 `plugin.data.batch` 的每一项）算作 `set`，`plugin.data.delete` 算作 `delete`。
- 结果存在时，按数据集的记录 schema 校验写入后的值，最多报告前 3 条错误。
- 宿主没有拿到数据集的 schema 文档时，写入一律被拒（`dataset schema of <ns> is unavailable`），不会放过。
- 没有声明数据集的命名空间不做这些检查。`key` 字段在提交时不检查。

**依赖会话内串行提交。** 读改写之所以正确，是因为同一个会话的提交按会话锁串行；PostgreSQL 多进程部署里这把锁是分布式的（见上面的 Action 级 plugin-rpc 锁边界）。两次执行各自准备 `inc +1`，先后提交，最终是两次都加上。会话锁之外的写入者不读当前值，可能覆盖：管理 API 的 `PUT` 插件数据，以及 plugin action RPC 的立即写入。

**挂起的写入基线。** 保存挂起时记录的写入基线（`takenUnder.writes`）只收录含 `set` 或 `delete` 的 `plugin.data.update`。只有相对操作（`merge`、`inc`、数组操作）的更新作用在提交时的最新值上，不会把旧的整个值写回去，所以不收录。

`isolatedRuntimes[].cause` 是结构化的丢弃原因：`rejected`（本单元提案被拒）、`upstream`（硬依赖未提交）、`read`（读过的生产方未提交）、`nested`（随父单元丢弃）。保留原有 `error` 文本；熔断不靠匹配文本归因。被拒提案按 `proposal.source.pluginId` 归属，不把整个单元都算成有错。

`FailedProposal.code: "hook-failed"` 表示 `PreStateCommit` 因 handler 抛错、超时或无效结果而失败，不是主动否决。只计 Hook 所属插件的故障，不能把 proposal 所属插件算成被主动拒绝。`dimension-version-conflict` 和 `suspension-data-changed` 也不计入[熔断](./protocol.md#插件故障熔断)。

## World Data import

规划阶段也校验接收插件声明的[维度引用和候选值](./world-data.md)。任何这类错误都会拒绝整份导入计划，不写入其他合法记录；同步遵守相同规则。

带 `worldData` 创建会话时，使用同一份 `DataStore` 事务约定。服务端先构建并校验导入计划，再把会话行和由导入器管理的写入包进一个事务：

- `sessions`
- `plugin_data`
- `lorebook`
- `characters`
- 保存在 `plugin_data` 里的媒体索引行
- `world_data_import_ledger`

没有接收插件的数据按[世界数据的接收规则](./world-data.md#target-uri)在规划时跳过，warning 不使事务失败。被跳过的部分不产生写入或新的导入账本行；同步保留它已有的托管数据、账本行和媒体引用。已启用的投影独立生成和同步自己的写入。

导入开始规划任何写入之前，先解析语言覆盖文件。source 的 `localeArrayKeys` 给出嵌套列表的身份字段（排在 `key` 和 `id` 之后），所以作者调整了列表顺序，译文记录仍然对得上。sync 也一样。

### 导入账本

`world_data_import_ledger` 为导入器管理的每一行会话数据记录来源：target、plugin id、namespace、key、source digest、value hash、schema ref、source id 和 managed 标记。

`/api/worlds/:id/sync-data` 用这份账本做三件事：dry-run、基于哈希的冲突检测，以及明确的 `force` 同步。

维度声明也进入账本，包括内联的、外部的声明，以及已保存的世界。

| 情况                                               | 结果                                    |
| -------------------------------------------------- | --------------------------------------- |
| 声明没有变化                                       | 保留进度                                |
| 新增一条声明                                       | 初始化它的值                            |
| 修改或删除一条已经演化过、被手改过或有待结算的记录 | 产生冲突                                |
| 对上面的冲突使用 `force`                           | 不绕过这些保护，也不把值迁移到新 schema |

- apply 在自己的事务里重新检查账本哈希和记录版本。冲突时保留现有的定义、值和版本。
- 有冲突的行被报告出来并保持原样。它不会挡住这次同步里的其他行。

### 媒体

媒体的字节存在 `MediaStore` 里。它的生命周期和 `DataStore` 分开。

- 世界数据导入在预检阶段校验媒体。
- 写媒体对象时，原子地同时建立一条唯一的临时引用，然后才写会话 store 里的媒体索引行。失败时回滚 `DataStore` 事务。
- 临时引用保护还没有发布的字节不被并发的 GC 回收。
- 收尾（finalization）先建立会话的归属声明（claims），再释放临时引用。准备或发布失败时，只释放这一次尝试的临时引用。
- sync 删除导入器管理的媒体索引行时，只移除当前会话那条明确的媒体引用。所有归属和引用声明都消失之后，生命周期 GC 才回收字节。
- 释放临时引用失败会记日志，不会掩盖导入本身的结果。
- 进程崩溃可能留下一条固定引用（pin）。它在创建满 24 小时后过期，由 `POST /api/media/cleanup` 释放（见 [媒体存储](./media-store.md#世界数据导入时的临时引用)）。
- sync 的语义数据已经提交、但媒体收尾失败时，临时引用保留着以保护这些数据。会话创建在收尾失败时总是释放它们，回滚删除会话失败也一样：留下的会话数据仍然引用这些文件，清理前的扫描会保护它们。

### Observability

事务性的提交产生的 `trace_events` 和非事务性的提交相同（proposal apply、提交成功或失败）。trace 里目前没有专门的“事务模式”字段。排查某次运行是否用了事务时，请看当前使用的存储后端。

## Schema changes

表和索引的 DDL 由 Drizzle schema（`packages/store/src/{sqlite,postgres}/schema.ts`）经 `packages/store/src/common/ddl-codegen.ts` 生成，使用 `CREATE TABLE IF NOT EXISTS`。

- 早期开发阶段，store 不迁移旧数据。更早的构建创建的数据库，只有在它的表已经和当前一致时才能启动。
- 对表、约束或索引的改动，如果旧的行不满足，会列在 `docs/CHANGELOG.md` 的 Breaking 下面，并说明要重建哪些开发数据。
- 启动时，store 会删除已退役的表和已退役的 plugin-data namespace。这是删除，不是转换。

## References

- 约定的类型：`packages/store/src/types.ts`（`DataStore` 接口）
- 约定测试：`packages/store/src/contract/store-contract.ts` 和 `packages/store/src/contract/suites/`
- `withTransaction` 嵌套守卫：`packages/store/src/tx-nesting-guard.ts`（只在 Node 上，AsyncLocalStorage）和 `packages/store/src/tx-nesting-error.ts`（浏览器里也安全的错误构造函数）
- 内核提交路径：`packages/runtime/src/commit/session-commit-pipeline.ts`、`packages/runtime/src/commit/session-commit-handlers.ts`
- MediaStore schema：[`media-store.md`](./media-store.md)

## World data 写入的一致性边界

- **`POST /worlds/:id/sync-dimensions`** 只同步维度账本和受保护的 `_dimensions` 记录。它在 **SessionLock + store transaction** 里重新验证并应用，不重建 `entries` 或 Lorebook。已经演化、被手改或有待结算的维度保持原样，并列在冲突报告里；其余维度照常写入。存储异常时整体回滚，返回 500。
- **`POST /worlds/:id/sync-data`** 的冲突扫描在事务外进行，因为它要读文件系统里的世界包。所以 apply 事务里会对每个要覆盖的目标**重读 hash 做 CAS**：扫描之后被改动过就整体中止，返回 `409 { code: "world_data_sync_conflict" }`。调用方重跑一次，新的扫描会把这次改动报为正常的 conflict。普通领域可以明确 `force`；维度的“已演化 / 待结算”保护不因此解除。维度使用 batch CAS，并持有会话写屏障；路由同时持有 SessionLock，挡住回合的并发写。
- **媒体和 DataStore 的生命周期不同。**
  - session create 和 sync 在语义事务之前准备媒体。`put` 原子地建立本次导入专属的临时引用。
  - 发布成功：先建立 session claims，再释放临时引用。
  - 提交前失败：只释放本次的临时引用。没有归属的字节交给 GC，不强制删除内容。
  - 提交后 finalization 失败：sync 保留保护。create 总是释放，回滚删除会话失败也一样，因为留下的会话数据仍然引用这些文件，清理前的扫描会保护它们。
  - 兼容的调用入口如果在 DataStore 事务里 materialize，也遵守同一条引用规则。
  - 进程崩溃可能留下临时引用。它在创建满 24 小时后过期，由媒体清理接口释放。
- **Compactor** 的 summary 写入和 message tag 在同一个事务里。只写 summary 会产生孤儿：`message-insertion` 会把它当 system message 发出，而没打 tag 的原始历史仍然注入，形成两份上下文。

### 记忆抽取作业

记忆抽取使用通用的 detached runtime 作业。

- 故事提交的事务同时保存 `turn-digest@1` 和作业记录。凭据只保留在进程内的交接表里；登记之后事务失败时，必须清理对应的凭据。
- Worker 把插件块的 proposal 和作业的完成回执放在同一个事务里提交。

`schedule.detached: { settle: true }` 让下一次执行在入口处等这些作业。

- 等待时不持有 SessionLock。取得锁之后再检查一次。
- 超过声明的等待预算时，记录 trace 并继续。
- 取消请求只中止等待。
- 相同 session / runtime 的作业按源回合的顺序处理。失败和超时作为终态放行。
- 显式重试不会覆盖更新的源回合的作业。
- 进程崩溃之后，已经 claim 的抽取不自动重放，避免重复调用和旧内容覆盖新内容。

凭据和关闭：

- 优先使用原请求带来的服务，其次使用可用的服务端配置。只有请求头凭据的部署，由后续的授权请求补交服务。
- 队列和快照不保存 API key。
- 凭据表是进程内的状态，不提供跨实例的“原请求优先”保证。
- 服务关闭时停止 claim，取消还没有进入提交的任务，并等 worker 持有的存储操作释放。已经进入提交的事务允许完成。
- 这不保证所有记忆提取都成功排空。向量摄取仍然是独立的路径。

## Derived vector-index progress

**摄取怎样处理失败。**

- embedding 摄取使用有界的批次，并限制每段输入文本的长度。
- 明确针对某段内容的拒绝，会被对半拆分，直到找出出问题的那一条。这一条不带向量地推进游标，后面的条目可以继续。
- 鉴权失败、未知错误和临时错误不会永久跳过条目。
- 归档内容被替换时，即使新内容无法 embedding，旧向量也会被移除。

**原子的批次写入。** `VectorStoreCapability` 提供 `getVectorIndexProgress(scope)` 和 `commitVectorIndexBatch(input)`，用来原子地写入向量和索引进度。

- scope 是 `(sessionId, pluginId, namespace)`。
- 更新要求两样东西：之前读到的序列化值（`null` 表示不存在），以及 `expectedSessionCreatedAt`。
- 一个批次可以包含 `deletes`（namespace / key 对）和 `upserts`（namespace / key / embedding / payload），范围限定在同一个会话和插件。
- 进度的 namespace 标识游标或哈希表。每一次向量修改各自写明它的数据 namespace。
- 先执行删除，再执行 upsert。所有修改和新的进度值一起提交。
- CAS 冲突返回 `false`，向量和进度都不变。
- 会话 incarnation 过期或不存在，或者任何一条修改无效，会抛错并回滚整个批次。
- 可选的 `expectedModelRegistryId` 写明这一批是用哪个模型嵌入的。会话已经锁到别的模型时，抛错并回滚整个批次。

各后端：PostgreSQL 用 `FOR KEY SHARE` 持有父会话行；SQLite 使用 immediate 事务；Memory 使用它串行化的 store 边界。这些操作不在 `StoreTransaction` 的业务数据视图上运行。

**换模型。** `VectorModelOps.resetSessionVectorIndex({ sessionId, expectedSessionCreatedAt, expectedModelRegistryId, target })` 在一个事务里删掉会话在当前模型下的全部向量和全部进度，再把会话锁到 `target`（`null` 表示解除锁定）。会话当前锁定的不是 `expectedModelRegistryId` 时返回 `false`，什么都不改；incarnation 不对时抛错。PostgreSQL 用 `FOR UPDATE` 锁住会话行，等持有 `FOR KEY SHARE` 的向量写入结束。

**进度存在哪里。** 进度属于 `vector_index_progress`，不属于 `plugin_data`。

- 会话的级联删除在同一个事务里清掉它；回滚这次级联会恢复它。
- 快照和 checkpoint 的导出从结构上就不包含它。所以恢复或 fork 出来的会话从自己的源数据行重建索引。

**删除和并发。**

- `deleteVectors` 可选地接受 `key`，用来移除所选范围里的一条；也可选地接受 `expectedSessionCreatedAt`，用来拒绝过期的异步删除。
- 摄取先读取全部归档来源并完成 embedding，再把对应的删除、upsert 和进度作为一个批次提交。
- 较旧的一趟扫描不能覆盖由较新的进度值拥有的向量。
- 可选的跨进程摄取锁可以减少重复的 embedding 工作，但正确性不依赖它。
- 对 embedding 服务商的调用从不在索引提交事务里运行，也不在业务数据事务里运行。
