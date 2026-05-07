# Covel E2E 插件测试指南（使用 aimock）

本文档说明如何使用 aimock 进行 E2E 插件测试，包括录制模式和纯回放模式。

## 快速开始

### 1. 启动 aimock 容器

```bash
# 启动 aimock 服务（录制+回放模式）
docker compose -f docker/docker-compose.mock.yml up -d

# 验证服务状态
curl http://localhost:4010/health  # story LLM (DeepSeek)
curl http://localhost:4011/health  # plugin LLM (DashScope)
```

### 2. 启动后端服务（指向 aimock）

```bash
# 方式1: 使用环境变量覆盖
export COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1
export COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1
pnpm dev:server

# 方式2: 完整开发环境（包含前端）
COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1 \
COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1 \
pnpm dev
```

### 3. 运行 E2E 测试脚本

```bash
# 首次运行（录制模式 - 会透传到真实 LLM 并保存 fixtures）
COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1 \
COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1 \
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts

# 后续运行（纯回放模式 - 快速，不调用真实 LLM）
AIMOCK_REPLAY_ONLY=1 \
COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1 \
COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1 \
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts
```

## 录制 vs 回放模式

### 录制模式（默认）

当 `fixtures/aimock/` 目录为空或缺少某些请求的 fixture 时：

1. aimock 会将请求透传到真实 LLM（DeepSeek / DashScope）
2. 收到响应后，aimock 会将请求-响应对保存为 fixture 文件
3. 后续相同的请求将直接从 fixture 回放

**特点**：

- 首次运行较慢（需要等待真实 LLM 响应）
- 会消耗真实 API 配额
- 生成 fixture 文件供后续回放

### 纯回放模式

设置环境变量 `AIMOCK_REPLAY_ONLY=1`：

1. aimock **只**回放已存在的 fixtures
2. 如果 fixture 不存在，返回 404 错误
3. **不会**透传到真实 LLM

**特点**：

- 运行极快（本地文件读取）
- 不消耗 API 配额
- 适合 CI/CD 环境
- 要求 fixtures 必须已完整录制

## Fixtures 存储位置

```
fixtures/
├── aimock/
│   ├── story/          # story LLM 录制的 fixtures (端口 4010)
│   │   └── *.json    # 每个 LLM 请求一个文件
│   └── plugin/         # plugin LLM 录制的 fixtures (端口 4011)
│       └── *.json
```

## 常见问题

### Q: Fixtures 没有被保存到目录中

**可能原因**：

1. **脚本未完成运行**：fixtures 只有在请求成功完成并返回响应后才会被保存。如果测试脚本被中断（Ctrl+C）或超时，fixtures 可能不会被写入。

2. **容器权限问题**：检查宿主机目录是否正确挂载到容器内：

   ```bash
   docker exec covel-llmock-story ls -la /fixtures
   docker exec covel-llmock-plugin ls -la /fixtures
   ```

3. **aimock 版本问题**：确保使用的是支持录制功能的版本：
   ```bash
   docker pull ghcr.io/copilotkit/aimock:latest
   ```

**解决方案**：

确保测试脚本完整运行到结束（看到最终报告），不要中途终止。

```bash
# 检查 fixtures 是否生成
ls -la fixtures/aimock/story/
ls -la fixtures/aimock/plugin/

# 如果没有 fixtures，重新运行完整测试
# （确保给足时间，首次运行可能需要 5-10 分钟）
```

### Q: 测试卡在 "→ 执行 send_message"

**原因**：首次运行需要等待真实 LLM 响应，每个请求可能需要 10-30 秒。

**解决方案**：增加脚本超时时间或耐心等待。

### Q: aimock 返回 404

**原因**：请求的 fixture 不存在（replay 模式下）。

**解决方案**：

- 如果是首次运行，去掉 `AIMOCK_REPLAY_ONLY=1`，让 aimock 录制新 fixtures
- 如果是后续运行，确保之前的录制已完成

## 环境变量参考

| 变量                    | 说明                 | 示例值                                                                            |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `COVEL_STORY_BASE_URL`  | Story 服务 LLM 端点  | `http://127.0.0.1:4010/v1` 或 `https://api.deepseek.com`                          |
| `COVEL_PLUGIN_BASE_URL` | Plugin 服务 LLM 端点 | `http://127.0.0.1:4011/v1` 或 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `AIMOCK_REPLAY_ONLY`    | 纯回放模式开关       | `1` 开启，`未设置` 为录制+回放                                                    |
| `DASHSCOPE_API_KEY`     | DashScope API 密钥   | `sk-...`                                                                          |
| `DEEPSEEK_API_KEY`      | DeepSeek API 密钥    | `sk-...`                                                                          |

## 一键测试脚本

创建 `scripts/e2e-mock.sh`（如果不存在）：

```bash
#!/bin/bash
set -e

REPLAY_MODE="${1:-}"

# 启动 aimock
echo "🚀 Starting aimock containers..."
docker compose -f docker/docker-compose.mock.yml up -d

# 等待服务就绪
echo "⏳ Waiting for aimock to be ready..."
until curl -sf http://localhost:4010/health > /dev/null 2>&1; do sleep 1; done
until curl -sf http://localhost:4011/health > /dev/null 2>&1; do sleep 1; done
echo "✅ aimock ready!"

# 启动后端服务
echo "🚀 Starting backend server..."
export COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1
export COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1
pnpm dev:server &
SERVER_PID=$!

# 等待后端就绪
echo "⏳ Waiting for backend to be ready..."
until curl -sf http://localhost:3001/api/health > /dev/null 2>&1; do sleep 1; done
echo "✅ Backend ready!"

# 运行测试
echo "🧪 Running E2E tests..."
if [ "$REPLAY_MODE" = "--replay" ]; then
    export AIMOCK_REPLAY_ONLY=1
    echo "Mode: REPLAY ONLY"
else
    echo "Mode: RECORD + REPLAY"
fi

npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts

# 清理
kill $SERVER_PID 2>/dev/null || true
echo "✅ Test completed!"
```

然后使用：

```bash
# 首次运行（录制）
bash scripts/e2e-mock.sh

# 后续运行（纯回放）
bash scripts/e2e-mock.sh --replay
```
