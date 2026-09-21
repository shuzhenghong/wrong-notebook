#!/usr/bin/env bash
# ============================================================
# 渐进迁移 —— 并行启动脚本
# 同时启动: Python FastAPI (:8000) + Next.js (:3000)
# 环境变量:
#   PYTHON_PROXY_ENABLED=true     让 Next.js catch-all 转发到 FastAPI
#   PYTHON_BACKEND_URL            默认 http://localhost:8000
#   TRUST_X_FORWARDED_USER=true   FastAPI 信任 Next.js 转发的用户 header
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$PROJECT_ROOT/python-backend"

PYTHON_PORT="${PYTHON_PORT:-8000}"
NEXT_PORT="${NEXT_PORT:-3000}"

# 检查依赖
if ! command -v python3 &>/dev/null; then
    echo "[err] python3 not found" && exit 1
fi
if ! command -v node &>/dev/null; then
    echo "[err] node not found" && exit 1
fi
if [ ! -d "$PYTHON_DIR/.venv" ] && ! python3 -c "import fastapi" 2>/dev/null; then
    echo "[err] FastAPI not installed, run: pip install -r python-backend/requirements.txt"
    exit 1
fi
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
    echo "[err] Next.js node_modules not installed, run: npm install"
    exit 1
fi

cd "$PROJECT_ROOT"

# ---- 启动 Python FastAPI ----
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  🐍  Python FastAPI → http://localhost:${PYTHON_PORT}/docs"
echo "║     (渐进迁移桥接: NextAuth → X-Forwarded-User)          ║"
echo "╚══════════════════════════════════════════════════════════╝"
(
    cd "$PYTHON_DIR"
    TRUST_X_FORWARDED_USER=true \
    uvicorn app.main:app --host 0.0.0.0 --port "$PYTHON_PORT" --reload
) &
PY_PID=$!

# ---- 启动 Next.js ----
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ⚡  Next.js App → http://localhost:${NEXT_PORT}         ║"
echo "║     (catch-all 转发层就绪: 删除 route.ts 即切换后端)    ║"
echo "║                                                          ║"
echo "║     /api/python/*  → 直连 FastAPI 测试通道 (always on)  ║"
echo "║     删除某个 API 的 route.ts 后                          ║"
echo "║       + PYTHON_PROXY_ENABLED=true 时 自动落回 FastAPI   ║"
echo "╚══════════════════════════════════════════════════════════╝"
(
    PYTHON_BACKEND_URL="http://localhost:${PYTHON_PORT}" \
    PYTHON_PROXY_ENABLED="${PYTHON_PROXY_ENABLED:-false}" \
    npm run dev -- -H 0.0.0.0 -p "$NEXT_PORT"
) &
NEXT_PID=$!

echo ""
echo "✅ 两个后端已启动, Ctrl+C 会同时停止"
echo "   FastAPI PID=$PY_PID  Next.js PID=$NEXT_PID"
echo ""

# 等待任一进程退出, 然后全部停止
trap 'echo "Cleaning up..."; kill $PY_PID $NEXT_PID 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM
wait
