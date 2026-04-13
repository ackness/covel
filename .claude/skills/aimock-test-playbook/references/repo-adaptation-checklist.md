# 任意 AI-heavy 仓库的适配盘点清单

这份参考用于调研任意仓库，不绑定具体业务。

## 1. 先找 provider 边界

优先查这些位置：

- SDK client 创建处
- `baseUrl` / `apiKey` / headers / transport 的注入点
- 应用内部对模型的抽象层，比如：
  - `LLMAdapter`
  - `AIClient`
  - `Gateway`
  - `ProviderRegistry`
  - `ChatService`
- stream parsing 代码
- fallback / retry / structured output 代码

目标是回答以下问题：

1. 能不能把 provider 地址切到本地 mock server？
2. 有没有一层已经足够 fake，不需要上 `aimock`？
3. 哪些测试的慢，来自真实 provider，而不是业务本身？

## 2. 把测试分成三堆

### A. fake / unit

保留在这里的测试通常验证：

- prompt 拼装
- orchestration / scheduling
- 工具调用顺序
- reducer / store / state transitions
- 路由校验
- persistence

这类测试通常不应仅为了“统一工具”而改接 `aimock`。

### B. replay / recorded

适合迁移到 `aimock` 的测试通常关注：

- provider 请求体是否正确
- 响应解析是否兼容真实格式
- streaming / tool calls / structured output
- fallback 链路
- UI/API 在稳定 AI 输出下的行为

### C. live / opt-in

只保留少量：

- provider drift smoke
- API key 与环境配置
- 发布前或 nightly 验证
- replay 无法代表真实供应商行为的高风险路径

## 3. 先找慢测试来源

问清楚慢是来自哪一层：

- provider network latency
- Playwright 页面等待
- 多轮 agent/tool 链路
- 数据准备过重
- fixture 不稳定导致重试

如果性能瓶颈主要来自 provider，请优先考虑 `aimock` 或录制回放方案；如果瓶颈来自业务编排本身，则应先处理测试结构问题。

## 4. 判断 aimock 是否适配

`aimock` 通常更适合具备以下特征的仓库：

- 通过 HTTP 或 SDK 调用 LLM
- OpenAI-compatible、Anthropic、Gemini 等 provider 边界明显
- 可以通过 env 或测试初始化切换 `baseUrl`
- 希望把 streaming / tool call 行为固化成 fixture

如果仓库主要通过注入式的内存 fake 接口完成测试，`aimock` 往往只是补充层，而不是主层。

## 5. 需要给用户的最小方案

至少输出：

1. 当前测试分层现状
2. 哪些测试继续 fake
3. 哪些测试迁到 replay
4. 哪些测试降成 opt-in live
5. 需要的新目录、fixture、脚本、环境变量
6. 默认 CI 应该只跑什么

## 6. 推荐目录和命名

建议使用显式的分层命名，避免所有脚本都混在 `test` 下面：

- `tests/unit`
- `tests/integration`
- `tests/replay`
- `tests/live`

或者脚本命名：

- `test:fast`
- `test:replay`
- `test:live`
- `e2e:smoke`
- `e2e:live`

## 7. 录制回放设计时要提醒用户的点

- fixture 命中规则会受到动态字段影响
- 时间戳、UUID、trace id 往往需要归一化
- stream replay 适合验证解析逻辑，不适合验证真实延迟体验
- 默认 CI 不应依赖人工重新录制
- live smoke 的数量应严格控制
