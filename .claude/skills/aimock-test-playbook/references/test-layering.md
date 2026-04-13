# 测试分层决策矩阵

## 一句话规则

先明确“当前测试要验证的是哪一层”，再决定使用 fake、replay 还是 live。

## 1. 选型表

| 目标 | 首选 | 为什么 |
| --- | --- | --- |
| prompt 拼装、调度、状态流转、插件触发 | fake LLM / fake adapter | 运行快，稳定性高，定位也更直接 |
| provider 请求体、响应体、stream parsing、fallback | aimock replay | 能保留真实协议格式，同时避免反复请求真实模型 |
| API key、供应商漂移、线上兼容性 | live smoke | 这类问题通常只有真实 provider 才能验证 |
| UI 是否能消费一段稳定 AI 输出 | aimock replay 或本地 fixture | 相比 live Playwright 更稳定 |

## 2. 什么时候不用 aimock

满足任一条件时，通常优先使用 fake：

- 被测代码根本不发 HTTP 请求
- 你能直接注入 `LLMAdapter`
- 你只关心“收到一段文本后系统怎么处理”
- 测试失败时，希望问题直接定位到业务逻辑，而不是 fixture 匹配

## 3. 什么时候非常适合 aimock

满足多个条件时，通常优先考虑 replay：

- 代码通过 `baseUrl` 或 SDK client 可切换 provider 地址
- 你关心 streaming / tool call / structured output 的 wire format
- 真实 provider 很慢、贵、容易抖
- 你希望 CI 可重复、可离线执行

## 4. 什么时候保留 live

通常只保留少量：

- provider 切换后的真实通路 smoke
- 定期 drift check
- 发布前手动验证
- 出现 replay 无法代表供应商真实行为的高风险路径

## 5. 给用户的推荐输出模板

当用户询问“如何优化慢测试”时，回答至少要包含：

1. 当前慢的是哪几类测试
2. 哪些继续 fake
3. 哪些切 aimock replay
4. 哪些降成 opt-in live
5. 默认 CI 只跑什么
6. 录制命令和回放命令

## 6. 推荐命名

建议把测试显式分成三组：

- `test:fast`
- `test:replay`
- `test:live`

如果有 Playwright，再单独拆：

- `e2e:smoke`
- `e2e:live`

这样可以让用户一眼看出哪些测试较慢、成本较高，或会访问真实 provider。
