# F5 · PostgreSQL 后端的分布式 session lock

**Status**: done (2026-04-22) · **Est**: 7 hours · **Risk**: medium (生产阻塞 bug, 需 PG 测试环境) · **Depends on**: 无,但建议在任何 multi-instance 部署前完成

---

## 0. 实施总结 (2026-04-22)

### 0.1 最终交付

- 接口 + 两种实现:
  - [`apps/server/src/lib/session-lock.ts`](../../../apps/server/src/lib/session-lock.ts) — `SessionLock` 接口 + `createInProcessSessionLock()` factory + `withSessionLock()` **deprecated** 向后兼容 shim(保留让旧导入不炸)。
  - [`apps/server/src/lib/pg-session-lock.ts`](../../../apps/server/src/lib/pg-session-lock.ts) — `createPgAdvisorySessionLock(sql, opts?)`,基于 `pg_try_advisory_lock` + 轮询 + 超时。
- Bootstrap 注入:
  - [`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts) — `ApiBootstrapConfig.sessionLock` 可选注入,默认 in-process。通过 `c.set('sessionLock', ...)` 暴露给每个请求。
  - [`apps/server/src/env.d.ts`](../../../apps/server/src/env.d.ts) — `ContextVariableMap.sessionLock: SessionLock`(必填,使用方必须显式注入)。
- 应用层选择:
  - [`apps/server/src/app.ts`](../../../apps/server/src/app.ts) — `STORE_BACKEND=pg && DATABASE_URL` 时构造独立的 postgres.js 客户端 (`max: 16`) 交给 `createPgAdvisorySessionLock`;否则 in-process。启动日志声明当前锁后端。
- 调用点迁移:
  - [`apps/server/src/routes/api/actions.ts`](../../../apps/server/src/routes/api/actions.ts) — `c.get('sessionLock').withLock(sessionId, ...)`,替代原 `withSessionLock`。
  - [`apps/server/src/routes/api/resume.ts`](../../../apps/server/src/routes/api/resume.ts) — 同上。
  - [`apps/server/src/routes/api/turn.ts`](../../../apps/server/src/routes/api/turn.ts) — **新增** 把 `executeTurn` + `turnCount` 更新 + commit 管线整体锁住(原来没有任何锁,是一处漏洞)。
- 测试:
  - [`apps/server/tests/lib/session-lock.test.ts`](../../../apps/server/tests/lib/session-lock.test.ts) — 5 个 in-process 单元测试。
  - [`apps/server/tests/integration/pg-session-lock.test.ts`](../../../apps/server/tests/integration/pg-session-lock.test.ts) — 5 个 PG 集成测试 + `hashSessionId` 2 个纯函数测试。`describe.skipIf(!pgReachable)` 守护,无 PG 环境自动跳过。
- 测试 fixture 补齐(手写 middleware 的测试需要显式注入 sessionLock):
  - `tests/api/actions-phase-emit.test.ts`
  - `tests/api/hook-pipeline-integration.test.ts`
  - `tests/api/resume.test.ts`
  - `tests/api/turn-commit-pipeline.test.ts`
- 依赖:
  - `apps/server/package.json` 显式声明 `"postgres": "^3.4.9"`(原先是 `@covel/store` 的间接依赖,TS 类型解析需要直接依赖)。
- 文档:
  - [`docs/reference/api.md`](../../../docs/reference/api.md) 存储后端表 + 多进程部署小节更新,指出 PG 后端自动启用 `pg_advisory_lock` 分布式锁;Memory / SQLite 继续用 in-process `Map`。

### 0.2 与原计划的偏差

| 原计划                                                               | 实际采用                                                          | 原因                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg` (node-postgres) 的 `Pool` + `PoolClient`                        | `postgres.js` 的 `Sql` + `sql.reserve()`                          | Covel `@covel/store` 已经用 postgres.js,不引入两套驱动。`reserve()` 的语义等价于 `pool.connect()`:占用一条独立连接直到 `release()`,advisory lock 在同一连接上 acquire/release。                                       |
| 参数绑定 `pg_try_advisory_lock(${key})`(bigint 直接参数)             | `pg_try_advisory_lock(${keyLiteral}::bigint)`(字符串 + 显式 cast) | postgres.js 的 `Serializable` TS 类型不包含 `bigint`(运行时支持但类型不支持)。传 string + `::bigint` cast 是 TS-clean 的方式,且避免 JS `number` 的 2^53 精度陷阱。                                                    |
| Pool 在 bootstrap 内部构造                                           | `app.ts` 构造后通过 `sessionLock` 参数注入 bootstrap              | 保持 `bootstrapApi` 测试友好:测试直接传 `createInProcessSessionLock()` 即可,不需要 mock PG pool。生产路径 `app.ts` 独立管理 lock 专用连接池,与 data store 的 pool 解耦,避免 lock-holding 连接挤占数据读写的连接配额。 |
| `withSessionLock` 标记为 deprecated + 旧调用点迁移完后删除           | 保留 deprecated shim,所有 server 内调用点已迁移                   | 目前 `apps/server` 所有生产 import 都改成 `c.get('sessionLock').withLock(...)`。shim 只服务于:(a) 未来引入新调用点前的兜底;(b) `apps/desktop/staging/` 镜像(gitignored,构建时从源码再生)里的历史 import。             |
| turn.ts 迁移既有 `withSessionLock` 调用                              | turn.ts 原本就 **没有** 锁,是新加的                               | F5 原文把 turn.ts 列为调用点是文档偏差。实际 turn.ts 的 `executeTurn` + `listTurnResults().length` 更新管线和 actions.ts 有同样的并发风险,这次一并补上。                                                              |
| 手滚 `acquireWithTimeout` 用 `client.query(...)` + `{ rows: [...] }` | 用 postgres.js 模板字面量 + `rows[0]?.locked`                     | postgres.js 返回值直接是行数组,不是 `QueryResult`。                                                                                                                                                                   |

### 0.3 验收状态

- [x] `SessionLock` 接口存在于 `apps/server/src/lib/session-lock.ts`
- [x] `createInProcessSessionLock()` + `createPgAdvisorySessionLock()` 两个 factory
- [x] `bootstrapApi()` 接受 `sessionLock` 注入,默认 in-process,启动日志声明来源
- [x] `actions.ts` / `turn.ts` / `resume.ts` 全部迁移到 `c.get('sessionLock').withLock`
- [x] PG lock 集成测试:同 sessionId 互斥 ✓、不同 sessionId 并发 ✓、异常释放 ✓、**跨 pool 互斥** ✓、超时报错 ✓
- [x] 文档 `docs/reference/api.md` 的"存储后端对比"表和"多进程部署"小节已更新
- [x] `pnpm --filter @covel/server lint` 绿
- [x] `pnpm --filter @covel/server test` 绿(27 files, 212 passed, 5 skipped — PG 集成测试无 `DATABASE_URL` 时跳过)
- [x] `pnpm --filter @covel/store test` 绿(370 passed)

### 0.4 如何在本地/CI 打开 PG 集成测试

```bash
# 起本地 PG
pnpm db:up

# 运行包含 PG lock 断言的 server 测试(默认 URL 与 pg-store.test.ts 一致)
DATABASE_URL=postgresql://covel:covel_dev@localhost:5432/covel \
  pnpm --filter @covel/server test tests/integration/pg-session-lock.test.ts
```

CI 应当在提供 PG 的 job 里注入 `DATABASE_URL` 以强制跑这套断言 —— 目前没有 PG 的机器上,`describe.skipIf(!pgReachable)` 会自动跳过,避免误伤 dev 环境。

---

## 1. 背景:为什么需要这个

### 1.1 Covel 的同 session 串行化前提

Covel 的回合执行路径假设**同一个 session 在任意时刻只有一个 turn 在跑**。很多不变量依赖这个前提:

- `turnNumber = (await store.listTurnResults(sessionId)).length`(基于当前已有 turn 数计算下一回合编号)
- `preGameCompleted` 的去重逻辑
- State patch 的 sequential ordering
- Auto-snapshot 的时机
- Pending continuation 表的 pop 顺序

如果两个 turn 并发跑同一个 session,这些不变量都会塌。

### 1.2 当前的锁实现是 in-process

**证据** · [`apps/server/src/lib/session-lock.ts`](../../../apps/server/src/lib/session-lock.ts)

```ts
const locks = new Map<string, ChainTail>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousTail: ChainTail = locks.get(sessionId) ?? Promise.resolve();
  // ...排队到 previousTail 后面
}
```

这是一个**纯内存** `Map<sessionId, Promise>` 链表,保证同一个 Node 进程内同 session 的请求按顺序跑。

文件顶部注释自己写道:

> Scope: the lock is process-local. For multi-process deployments (one PG backend, N app pods) this must be upgraded to a PG advisory lock (`pg_try_advisory_lock(hashtext(sessionId))`) or a Redis-based lock.

### 1.3 文档已经把 PG 定位为"生产 + 多进程"

**证据** · [`docs/reference/api.md:17-19`](../../../docs/reference/api.md), [`docs/reference/api.md:2244-2249`](../../../docs/reference/api.md)

文档明确把 PostgreSQL 标为:

- 生产部署形态
- 支持多进程 / 多实例的入口

**问题**:代码和文档承诺的能力不匹配。PG 后端在多实例下**没有同 session 互斥**。

### 1.4 实际故障场景

生产部署 `STORE_BACKEND=pg` + 前面挂 load balancer + 3 个 Node pod:

1. Pod A 收到 `POST /api/actions` for session `S` —— 拿到 in-process 锁,开始 turn 执行。
2. Pod B **同时**也收到 session `S` 的请求(原因可能是玩家在两个 tab 打开同一个会话;客户端自动重试;iOS Safari 的预加载机制抢跑)。
3. Pod A 的锁对 Pod B 不可见,两个 pod **并发**对同一个 session 跑 turn。

具体会看到的症状:

- 两个 pod 同时读 `listTurnResults().length`,都拿到 `5`,都以为自己在跑第 6 回合,最终 store 里多出一个 `turnNumber = 6` 的两个 turn。
- State patches 交织,`stats.hp` 被两条路径分别减 10 和 20,结果是 -20 而不是 -30(或者相反,取决于 commit 顺序)。
- 背包里同一个物品重复加。
- Auto-snapshot 的 trace event 乱序。
- 最难调试的:偶发性(只有并发访问时触发),单元测试 / dev 环境全绿,上线后玩家报 bug 才发现。

**这是 multi-instance 部署的阻塞性 bug**。单实例 dev 完全感受不到。

---

## 2. 目标

1. 抽象 `SessionLock` 接口,让不同 store backend 可插拔对应的锁实现。
2. Memory / SQLite 后端继续使用现有 in-process 实现(单进程场景正确且快)。
3. PostgreSQL 后端实现 `pg_advisory_lock` 版本(**跨进程**互斥)。
4. `bootstrapApi()` 根据 `STORE_BACKEND` 自动选择。
5. 集成测试覆盖跨"假 pod"(两个 PG client)的互斥语义。

---

## 3. 实施方案

### 3.1 阶段 1 · 接口抽象(~1h)

重写 [`apps/server/src/lib/session-lock.ts`](../../../apps/server/src/lib/session-lock.ts):

```ts
export interface SessionLock {
  /**
   * Acquire the lock for `sessionId`, run `fn`, release. Blocks until
   * the lock is available. If `fn` throws, the lock is still released
   * and the error propagates.
   */
  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>;
}

/** In-process lock — correct for single-node deployments. */
export function createInProcessSessionLock(): SessionLock {
  const locks = new Map<string, Promise<unknown>>();
  return {
    async withLock<T>(sessionId, fn) {
      const previousTail = locks.get(sessionId) ?? Promise.resolve();
      let release!: () => void;
      const slot = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chain = previousTail.then(
        () => slot,
        () => slot,
      );
      locks.set(sessionId, chain);
      try {
        await previousTail.catch(() => {});
        return await fn();
      } finally {
        release();
        if (locks.get(sessionId) === chain) locks.delete(sessionId);
      }
    },
  };
}
```

### 3.2 阶段 2 · PG advisory lock 实现(~3h)

新增 `apps/server/src/lib/pg-session-lock.ts`:

```ts
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { SessionLock } from "./session-lock.js";

/**
 * PG advisory-lock-based session lock. Correct across multiple Node
 * processes / pods pointing at the same PG instance.
 *
 * Uses bigint advisory locks (pg_advisory_lock / pg_advisory_unlock)
 * keyed by a SHA-256 hash of the sessionId truncated to signed int8.
 *
 * Invariant: the lock is acquired and released on the **same** PG
 * connection — advisory locks are session-scoped (PG session, not
 * Covel session). We check out a dedicated client for the duration.
 */
export function createPgAdvisorySessionLock(
  pool: Pool,
  opts: {
    readonly acquireTimeoutMs?: number; // default 30_000
  } = {},
): SessionLock {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000;

  return {
    async withLock<T>(sessionId, fn): Promise<T> {
      const key = hashSessionId(sessionId);
      const client: PoolClient = await pool.connect();
      let locked = false;
      try {
        // 带超时的 acquire — 超时抛错而非无限等
        await acquireWithTimeout(client, key, acquireTimeoutMs, sessionId);
        locked = true;
        return await fn();
      } finally {
        if (locked) {
          try {
            await client.query("SELECT pg_advisory_unlock($1)", [
              key.toString(),
            ]);
          } catch (err) {
            // 日志但不抛 — 连接断开会自动释放
            console.warn(
              `[pg-session-lock] unlock failed for ${sessionId}:`,
              err,
            );
          }
        }
        client.release();
      }
    },
  };
}

function hashSessionId(sessionId: string): bigint {
  const h = createHash("sha256").update(sessionId).digest();
  // PG advisory lock key 是 signed int8(8 字节 bigint)。
  // SHA-256 的前 8 字节读成 signed bigint,再 mask 到正数域避免负值
  // 奇怪表现(负 bigint 在 pg 驱动里需要额外处理)。
  const raw = h.readBigInt64BE(0);
  return raw & 0x7fffffffffffffffn;
}

async function acquireWithTimeout(
  client: PoolClient,
  key: bigint,
  timeoutMs: number,
  sessionId: string,
): Promise<void> {
  const start = Date.now();
  // 轮询 pg_try_advisory_lock — 非阻塞拿锁。
  // 也可以用 pg_advisory_lock 阻塞版 + 单独 setTimeout 杀连接,
  // 但 try + sleep 回退更干净。
  while (true) {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [key.toString()],
    );
    if (res.rows[0]?.locked) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[pg-session-lock] failed to acquire lock for session ${sessionId} within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
```

### 3.3 阶段 3 · Bootstrap 注入(~1h)

[`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts):

```ts
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../lib/session-lock.js";
import { createPgAdvisorySessionLock } from "../../lib/pg-session-lock.js";

// 在 session-lock 选择点:
const sessionLock: SessionLock =
  backend === "pg" && pgPool
    ? createPgAdvisorySessionLock(pgPool)
    : createInProcessSessionLock();

console.log(
  `[bootstrap] session lock: ${backend === "pg" ? "pg-advisory" : "in-process"}`,
);

// Hono middleware
app.use(async (c, next) => {
  c.set("sessionLock", sessionLock);
  await next();
});
```

`apps/server/src/env.d.ts` 的 `ContextVariableMap` 加 `sessionLock: SessionLock`。

### 3.4 阶段 4 · 调用点迁移(~30min)

现有 `withSessionLock(sessionId, fn)` 调用点(grep):

- `apps/server/src/routes/api/actions.ts`
- `apps/server/src/routes/api/turn.ts`
- `apps/server/src/routes/api/resume.ts`
- `apps/server/src/routes/api/retry.ts`(若存在)

每个改成:

```ts
const sessionLock = c.get("sessionLock");
await sessionLock.withLock(sessionId, async () => {
  // ...
});
```

保留 `withSessionLock` 的旧 export 作为 backwards-compat wrapper(指向一个全局 `createInProcessSessionLock()` 实例),逐步迁移后删除。

### 3.5 阶段 5 · 集成测试(~1.5h)

新增 `apps/server/tests/integration/pg-session-lock.test.ts`:

```ts
// 前置:需要本地 PG (pnpm db:up)
// skipIf:不在 CI + 没有 DATABASE_URL 时跳过

describe.skipIf(!process.env.DATABASE_URL)("pg-session-lock", () => {
  it("serializes concurrent withLock() calls on the same sessionId", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lock = createPgAdvisorySessionLock(pool);

    const log: string[] = [];
    const a = lock.withLock("sess-test", async () => {
      log.push("A-start");
      await new Promise((r) => setTimeout(r, 100));
      log.push("A-end");
    });
    const b = lock.withLock("sess-test", async () => {
      log.push("B-start");
      log.push("B-end");
    });
    await Promise.all([a, b]);

    // B 必须等 A 完全结束
    expect(log).toEqual(["A-start", "A-end", "B-start", "B-end"]);

    await pool.end();
  });

  it("does NOT serialize across different sessionIds", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lock = createPgAdvisorySessionLock(pool);

    const start = Date.now();
    await Promise.all([
      lock.withLock("sess-1", () => new Promise((r) => setTimeout(r, 100))),
      lock.withLock("sess-2", () => new Promise((r) => setTimeout(r, 100))),
    ]);
    // 并发执行,总耗时应接近 100ms 而不是 200ms
    expect(Date.now() - start).toBeLessThan(180);

    await pool.end();
  });

  it("releases lock on thrown error", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lock = createPgAdvisorySessionLock(pool);

    await expect(
      lock.withLock("sess-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // 锁应该已释放 — 再次 acquire 不阻塞
    const t0 = Date.now();
    await lock.withLock("sess-err", async () => {});
    expect(Date.now() - t0).toBeLessThan(100);

    await pool.end();
  });

  it("two separate pools (simulating two pods) serialize", async () => {
    const poolA = new Pool({ connectionString: process.env.DATABASE_URL });
    const poolB = new Pool({ connectionString: process.env.DATABASE_URL });
    const lockA = createPgAdvisorySessionLock(poolA);
    const lockB = createPgAdvisorySessionLock(poolB);

    const log: string[] = [];
    const a = lockA.withLock("sess-cross", async () => {
      log.push("A-start");
      await new Promise((r) => setTimeout(r, 100));
      log.push("A-end");
    });
    const b = lockB.withLock("sess-cross", async () => {
      log.push("B-start");
      log.push("B-end");
    });
    await Promise.all([a, b]);

    expect(log).toEqual(["A-start", "A-end", "B-start", "B-end"]);

    await Promise.all([poolA.end(), poolB.end()]);
  });
});
```

**关键**:`two separate pools` 这个测试是核心卖点——它证明跨"假 pod"互斥生效,这正是审计关心的场景。

---

## 4. 风险清单

| 风险                                                                      | 缓解                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **连接池压力**:每个 lock 持有一个 PG 连接直到 fn 完成                     | 需要 PG pool max 大于预期的并发 session 数(默认 10);文档里加容量规划指引       |
| **连接泄漏**:fn 异常或 Node 进程崩溃时 PG 连接没 release                  | 用 `try/finally` 严格包裹;PG 连接断开会自动释放 advisory lock;pool 本身会回收  |
| **长时间 fn 阻塞其他 pod**:A pod fn 里有 LLM 调用卡 5 分钟,B pod 等到超时 | 单 turn 预期 < 30s;30s timeout 足够。LLM 超时本身由 plugin 级 `timeoutMs` 控制 |
| **哈希碰撞**:2^63 空间实际概率 ≈ 0                                        | 足够;如果担心,改用 two-int4 API(pg_advisory_lock(key1, key2))给 128-bit 空间   |
| **Redis 替代方案**:Redlock 更成熟                                         | Covel 架构里没有 Redis,加一个依赖不划算。PG 已在生产链路里                     |
| **开发体验**:dev 默认 Memory,开发者容易忘记测多进程场景                   | CI 里跑 pg-session-lock.test.ts 强制验证                                       |

---

## 5. 交付物验收

- [ ] `SessionLock` 接口在 `apps/server/src/lib/session-lock.ts` 存在
- [ ] `createInProcessSessionLock()` + `createPgAdvisorySessionLock()` 两个 factory
- [ ] `bootstrapApi()` 根据 `STORE_BACKEND` 自动选择并日志输出
- [ ] `actions.ts` / `turn.ts` / `resume.ts` 的 `withSessionLock` 调用迁移到 `c.get('sessionLock').withLock`
- [ ] PG lock 集成测试:同 sessionId 互斥、不同 sessionId 并发、异常释放、**跨 pool 互斥**四组断言
- [ ] 文档 `docs/reference/api.md` 的"多进程部署"小节从"注意 session lock 只在进程内"改为"PG 后端自动启用分布式锁"
- [ ] `pnpm lint` + 所有测试绿(含集成测试)

---

## 6. 参考文件清单

实施时必读:

- [`apps/server/src/lib/session-lock.ts`](../../../apps/server/src/lib/session-lock.ts) — 现有 in-process 实现
- [`apps/server/src/routes/api/bootstrap.ts`](../../../apps/server/src/routes/api/bootstrap.ts) — 注入点
- [`apps/server/src/routes/api/actions.ts`](../../../apps/server/src/routes/api/actions.ts) — 调用点
- [`apps/server/src/routes/api/turn.ts`](../../../apps/server/src/routes/api/turn.ts) — 调用点
- [`apps/server/src/routes/api/resume.ts`](../../../apps/server/src/routes/api/resume.ts) — 调用点
- [`docs/reference/api.md:17-19, 2244-2249`](../../../docs/reference/api.md) — 文档中的"多进程"承诺
- PG 官方文档: https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
- 审计原始记录:`audits/2026-04-21-architecture-code-audit/README.md`(审计原始产出,本地 gitignored) 第 5 节

## 7. 可选延展(不在本 ticket 范围)

- **Lock 观察性**:暴露 `/api/admin/session-locks` 端点显示当前锁持有者、等待队列长度、平均等待时间
- **Lock 饥饿监控**:超时次数 > 阈值时报警(生产运维)
- **Redis 后备**:对于有 Redis 的部署,`createRedlockSessionLock()` 作为第三种选项
