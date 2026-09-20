#!/bin/sh
set -e

# Define paths
SOURCE_DB="/app/prisma/dev.db"
TARGET_DB="/app/data/dev.db"
SEED_MARKER="/app/data/.seed_completed"
VERSION_FILE="/app/data/.app_version"
# Use local Prisma CLI from node_modules
PRISMA_BIN="node /app/node_modules/prisma/build/index.js"
SEED_ADMIN_SCRIPT="/app/dist-scripts/scripts/seed-admin.js"
REBUILD_TAGS_SCRIPT="/app/dist-scripts/scripts/rebuild-system-tags.js"

# Get current app version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

# Fix permissions for data and config directories
chown -R nextjs:nodejs /app/data /app/config

# === 安全加固：NEXTAUTH_SECRET ===
# 缺失 / 占位值 / 过短时自动生成强随机密钥并持久化到数据卷，
# 让首次部署零配置也能启动（此前会直接 FATAL 退出，容器根本起不来）。
SECRET_FILE="/app/data/.nextauth_secret"

is_valid_secret() {
    [ -n "$1" ] \
        && [ "${#1}" -ge 16 ] \
        && [ "$1" != "your_secret_key" ] \
        && [ "$1" != "changeme" ]
}

if ! is_valid_secret "$NEXTAUTH_SECRET"; then
    if [ -s "$SECRET_FILE" ]; then
        NEXTAUTH_SECRET=$(cat "$SECRET_FILE")
        echo "[Entrypoint] NEXTAUTH_SECRET 未设置或无效，已复用数据卷中的既有密钥: $SECRET_FILE"
    else
        NEXTAUTH_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
        ( umask 077; printf '%s' "$NEXTAUTH_SECRET" > "$SECRET_FILE" ) \
            || echo "[Entrypoint] 警告: 无法写入 $SECRET_FILE，密钥仅本次运行有效"
        echo "[Entrypoint] NEXTAUTH_SECRET 未设置，已自动生成 64 位随机密钥并保存到 $SECRET_FILE"
        echo "[Entrypoint] 提示: 多实例部署请显式设置 NEXTAUTH_SECRET；删除该文件会使所有登录会话失效。"
    fi
fi
export NEXTAUTH_SECRET

# Check if the persistent database exists
if [ ! -s "$TARGET_DB" ]; then
    echo "[Entrypoint] Initializing database..."
    if [ -f "$SOURCE_DB" ]; then
        echo "[Entrypoint] Copying pre-packaged database from $SOURCE_DB to $TARGET_DB"
        cp "$SOURCE_DB" "$TARGET_DB"
        # Ensure correct permissions
        chown nextjs:nodejs "$TARGET_DB"
        # Mark as seeded since pre-packaged DB includes seed data
        touch "$SEED_MARKER"
        # Record initial version
        echo "$CURRENT_VERSION" > "$VERSION_FILE"
    else
        echo "[Entrypoint] Source database not found at $SOURCE_DB. Initializing with migrations."
    fi
else
    echo "[Entrypoint] Database already exists at $TARGET_DB."
fi

# Check for version upgrade
PREVIOUS_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    PREVIOUS_VERSION=$(cat "$VERSION_FILE")
fi

# Run migrations to ensure DB schema is available and up to date.
echo "[Entrypoint] Running database migrations to sync schema..."
cd /app && $PRISMA_BIN migrate deploy --schema=./prisma/schema.prisma && {
    echo "[Entrypoint] Migrations completed successfully."
} || echo "[Entrypoint] Migration failed or no pending migrations."

# 首次部署初始化管理员账号。
# - 未设置 DEFAULT_ADMIN_PASSWORD 时自动生成强随机密码，并在下方部署日志中打印
#   （同时落盘到 /app/data/initial-admin-credentials.txt，避免日志被冲掉后无法登录）
# - 管理员已存在时只校正 role/isActive，绝不覆盖用户已修改过的密码
echo "[Entrypoint] Ensuring admin user exists (首次部署会自动创建账号并打印凭据)..."
if ! cd /app && node "$SEED_ADMIN_SCRIPT"; then
    echo "[Entrypoint][FATAL] Admin seed failed. 常见原因："
    echo "  1) 数据卷 /app/data 不可写（检查宿主机 ./data 目录权限）"
    echo "  2) 数据库文件损坏或迁移未完成（见上方 migrate 日志）"
    echo "  3) bcryptjs 模块缺失 — 检查 node_modules/bcryptjs/umd/ 是否存在"
    echo "     → 这是 Next.js standalone 裁剪导致的已知问题，需确认 Dockerfile 已显式复制 bcryptjs"
    echo ""
    echo "  → 修复后重启容器即可，账号初始化会自动重试。"

    # 附加诊断信息，帮助快速定位
    echo ""
    echo "[Entrypoint] --- 诊断 ---"
    echo "[Entrypoint] node_modules/bcryptjs 内容: $(ls /app/node_modules/bcryptjs/ 2>/dev/null || echo '不存在')"
    echo "[Entrypoint] node_modules/bcryptjs/umd 内容: $(ls /app/node_modules/bcryptjs/umd/ 2>/dev/null || echo '不存在')"
    exit 1
fi
touch "$SEED_MARKER" 2>/dev/null

# Check if version changed - rebuild system tags automatically
if [ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]; then
    echo "[Entrypoint] Version upgrade detected: $PREVIOUS_VERSION -> $CURRENT_VERSION"
    echo "[Entrypoint] Rebuilding system tags to sync with new version..."
    cd /app && node "$REBUILD_TAGS_SCRIPT" && {
        echo "[Entrypoint] System tags rebuilt successfully."
    } || echo "[Entrypoint] Tag rebuild failed (non-fatal, continuing...)."
    # Update version marker
    echo "$CURRENT_VERSION" > "$VERSION_FILE"
fi

# HTTPS Setup
CERT_DIR="/app/certs"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [ "$HTTPS_ENABLED" = "true" ]; then
    echo "[Entrypoint] HTTPS enabled"
    
    # 确保证书目录存在
    mkdir -p "$CERT_DIR"
    chown nextjs:nodejs "$CERT_DIR"
    
    # 检查证书是否存在
    if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 证书不存在，自动生成自签名证书..."
        
        # 获取证书 CN（优先使用环境变量，否则使用 localhost）
        CERT_CN="${CERT_DOMAIN:-localhost}"
        
        # 生成自签名证书（有效期 10 年）
        openssl req -x509 -newkey rsa:2048 \
            -keyout "$KEY_FILE" \
            -out "$CERT_FILE" \
            -days 3650 \
            -nodes \
            -subj "/CN=$CERT_CN" \
            2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo "[Entrypoint] 自签名证书生成成功: CN=$CERT_CN"
            chown nextjs:nodejs "$CERT_FILE" "$KEY_FILE"
        else
            echo "[Entrypoint] 警告: 证书生成失败，HTTPS 将不可用"
        fi
    else
        echo "[Entrypoint] 使用已有证书: $CERT_FILE"
    fi
    
    # 启动 HTTPS 代理
    if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
        echo "[Entrypoint] 启动 HTTPS 代理 (端口 443)..."
        gosu nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec gosu nextjs:nodejs "$@"
