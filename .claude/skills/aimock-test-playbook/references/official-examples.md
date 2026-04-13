# 官方示例整理

这份参考只整理 `CopilotKit/aimock` 官方仓库和官方文档里的示例，方便快速改写到用户项目里。

优先级：

1. 官方站点当前文档
2. 官方仓库 `README.md`
3. 官方仓库源码与 fixture 示例

## 1. 程序化最小示例

来源：

- `README.md`

```ts
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({ port: 0 });
mock.onMessage("hello", { content: "Hi there!" });
await mock.start();

process.env.OPENAI_BASE_URL = `${mock.url}/v1`;

// run tests

await mock.stop();
```

适用场景：

- 项目没有统一 test plugin
- 想先验证 `baseUrl` 切换是否成立
- 需要在单个 suite 内手动控制 lifecycle

## 2. Vitest 插件示例

来源：

- 官方文档 `/test-plugins`
- 官方源码 `src/vitest.ts`

```ts
import { useAimock } from "@copilotkit/aimock/vitest";

const mock = useAimock({ fixtures: "./fixtures" });

it("responds to hello", async () => {
  const res = await myApp.chat("hello");
  expect(res).toBe("Hi there!");
});
```

官方实现要点：

- `beforeAll`：启动 server，加载 fixtures，可自动 patch env
- `beforeEach`：重置 fixture match counts
- `afterAll`：停止 server，恢复 env
- 默认会设置：
  - `OPENAI_BASE_URL`
  - `ANTHROPIC_BASE_URL`

适用场景：

- 测试套件已经是 Vitest
- 项目通过 env 读取 provider base URL
- 想减少手写 `beforeAll/afterAll`

## 3. Jest 插件示例

来源：

- 官方文档 `/test-plugins`
- 官方源码 `src/jest.ts`

```ts
import { useAimock } from "@copilotkit/aimock/jest";

const mock = useAimock({ fixtures: "./fixtures" });

it("responds to hello", async () => {
  const res = await myApp.chat("hello");
  expect(res).toBe("Hi there!");
});
```

如果仓库使用 Jest，这通常是最省事的接法。

## 4. CLI record/replay

来源：

- `README.md`
- 官方文档 `/record-replay`

```bash
npx aimock --fixtures ./fixtures \
  --record \
  --provider-openai https://api.openai.com \
  --provider-anthropic https://api.anthropic.com
```

相关模式：

```bash
npx aimock --fixtures ./fixtures --proxy-only --provider-openai https://api.openai.com
npx aimock --strict -f ./fixtures
```

使用建议：

- `--record`：首次录制 fixture
- `--proxy-only`：代理真实请求但不落盘，适合 demo / 过渡期
- `--strict`：CI 推荐，未命中直接失败，不让真实请求悄悄漏过去

## 5. Programmatic recording

来源：

- 官方文档 `/record-replay`

```ts
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock();
await mock.start();

mock.enableRecording({
  providers: {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
  },
  fixturePath: "./fixtures/recorded",
  proxyOnly: true,
});

// make requests

mock.disableRecording();
```

适用场景：

- 测试里想先跑一次 live，再把 fixture 固化
- 不想靠外部 CLI 管理 aimock lifecycle

## 6. requestTransform 示例

来源：

- 官方文档 `/record-replay`

```ts
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({
  requestTransform: (req) => ({
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? m.content.replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, "")
          : m.content,
    })),
  }),
});
```

这是录制回放中非常关键的高级能力之一。凡是 prompt 中包含：

- 时间戳
- UUID
- session id
- trace id
- 动态环境标识

都应优先考虑做归一化处理，否则 fixture 往往很快就会失效。

## 7. 官方 fixture 样例

来源：

- `fixtures/example-greeting.json`
- `fixtures/example-tool-call.json`
- `fixtures/example-multi-turn.json`
- `fixtures/examples/llm/*`

### 简单 greeting

```json
{
  "fixtures": [
    {
      "match": { "userMessage": "hello" },
      "response": { "content": "Hello! How can I help you today?" }
    },
    {
      "match": { "userMessage": "goodbye" },
      "response": { "content": "Goodbye! Have a great day!" }
    }
  ]
}
```

### tool call

```json
{
  "fixtures": [
    {
      "match": { "toolName": "get_weather" },
      "response": {
        "toolCalls": [
          {
            "name": "get_weather",
            "arguments": "{\"location\":\"San Francisco\",\"unit\":\"fahrenheit\"}"
          }
        ]
      }
    }
  ]
}
```

### multi-turn / sequence

官方 examples 目录里还有：

- `sequential-responses.json`
- `streaming-physics.json`
- `error-injection.json`

这些示例适合直接改造成：

- 多轮 agent 对话
- 流式 UI 验证
- 限流 / provider error handling

## 8. GitHub Action 示例

来源：

- `README.md`
- `action.yml`

README 最小例子：

```yaml
- uses: CopilotKit/aimock@v1
  with:
    fixtures: ./test/fixtures

- run: npm test
  env:
    OPENAI_BASE_URL: http://127.0.0.1:4010/v1
```

`action.yml` 里能看到的主要输入：

- `fixtures`
- `config`
- `port`
- `host`
- `version`
- `args`
- `wait-timeout`

如果要在 CI 中强制要求 fixture 覆盖完整，建议优先加上：

```yaml
args: --strict
```

## 9. 如何在用户项目里复用这些示例

改写到用户项目时，通常只需要替换以下内容：

- 测试框架：Vitest / Jest / Playwright
- provider env 名
- fixture 目录
- app 调用入口
- 需要归一化的动态字段

不要直接照搬全部示例。应先确认用户仓库属于哪一类：

- env 驱动的 SDK client
- `baseUrl` 驱动的 HTTP adapter
- 还是内部 `LLMAdapter` 抽象

只有前两类项目，才适合优先采用 `aimock` 的官方接法。
