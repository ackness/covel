#!/bin/bash
set -e

REPLAY_MODE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# ── Step 1: 预处理 replay fixtures（仅 replay 模式）──────────────
# 说明：
# - record+replay 模式下，如果预先加载旧 fixtures.json，stale 响应会在新录制前被错误回放，
#   导致 tool loop 卡住但看起来像“模型一直重复调用同一个工具”。
# - 因此只有 --replay 才生成并加载 fixtures.json。
if [ "$REPLAY_MODE" = "--replay" ]; then
    echo "📦 Processing recorded fixtures → fixtures.json ..."
    npx tsx scripts/process-fixtures.ts || echo "  (无录制文件，跳过)"
else
    echo "📦 Record mode: skipping fixtures.json preload to avoid stale replay matches"
fi

# ── Step 2: 启动 aimock ───────────────────────────────────────────
AIMOCK_RUNNING=false
if curl -sf http://localhost:4010/health > /dev/null 2>&1; then
    echo "🔄 aimock already running — restarting containers..."
    docker compose -f docker/docker-compose.mock.yml restart
    AIMOCK_RUNNING=true
else
    echo "🚀 Starting aimock containers..."
    docker compose -f docker/docker-compose.mock.yml up -d
fi

echo "⏳ Waiting for aimock to be ready..."
until curl -sf http://localhost:4010/health > /dev/null 2>&1; do sleep 1; done
until curl -sf http://localhost:4011/health > /dev/null 2>&1; do sleep 1; done
echo "✅ aimock ready!"

# ── Step 3: 启动后端（如未运行）───────────────────────────────────
BACKEND_RUNNING=false
if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "ℹ️  Backend already running, reusing existing server"
    BACKEND_RUNNING=true
fi

SERVER_PID=""
if [ "$BACKEND_RUNNING" = false ]; then
    echo "🚀 Starting backend server..."
    export COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1
    export COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1
    pnpm dev:server &
    SERVER_PID=$!

    echo "⏳ Waiting for backend to be ready..."
    for i in {1..60}; do
        if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
            echo "✅ Backend ready!"
            break
        fi
        sleep 1
    done
fi

# ── Step 4: 运行测试 ──────────────────────────────────────────────
echo "🧪 Running E2E tests..."
export COVEL_STORY_BASE_URL=http://127.0.0.1:4010/v1
export COVEL_PLUGIN_BASE_URL=http://127.0.0.1:4011/v1

if [ "$REPLAY_MODE" = "--replay" ]; then
    export AIMOCK_REPLAY_ONLY=1
    echo "Mode: REPLAY ONLY (fixtures.json must be complete)"
else
    echo "Mode: RECORD + REPLAY (new requests → real LLM → recorded/)"
fi

npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts
TEST_EXIT=$?

# ── Step 5: 清理后端（仅当本脚本启动了后端时）────────────────────
if [ -n "$SERVER_PID" ]; then
    echo "🛑 Stopping backend server..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
fi

# ── Step 6: replay fixtures 仅在 replay 需求明确时手动生成 ───────
echo ""
echo "✅ Test completed! (exit=$TEST_EXIT)"
if [ "$REPLAY_MODE" = "--replay" ]; then
    echo "   使用的是预生成 fixtures.json 回放"
else
    echo "   本次新录制已写入 recorded/；如需纯回放，请手动运行："
    echo "   npx tsx scripts/process-fixtures.ts"
    echo "   然后重启 aimock 容器"
fi
exit $TEST_EXIT
