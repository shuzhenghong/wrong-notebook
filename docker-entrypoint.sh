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

# === 安全加固 ===
# 强制校验 NEXTAUTH_SECRET（示例值 / 空 / 过短都拒绝）
if [ -z "$NEXTAUTH_SECRET" ] \
    || [ "${#NEXTAUTH_SECRET}" -lt 16 ] \
    || [ "$NEXTAUTH_SECRET" = "your_secret_key" ] \
    || [ "$NEXTAUTH_SECRET" = "changeme" ]; then
    echo "[Entrypoint][FATAL] NEXTAUTH_SECRET is missing, too short (<16), or a well-known placeholder."
    echo "[Entrypoint] Aborting. Set a strong, random secret in your environment and restart."
    exit 1
fi

# 如果用户没提供 DEFAULT_ADMIN_PASSWORD，但容器里还没有任何管理员用户，
# 我们在 entrypoint 层面就拒绝启动 —— 避免 seed-admin.js 硬编码弱密码兜底。
# （存在 pre-packaged DB 的场景会在上面的 cp 分支里继续走，不会进这里的全新 DB 路径。）

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

# Always run seed after migrations to ensure admin user has correct role/isActive.
# seed-admin.js 只会在 "DB 里已有 admin" 时补 role/isActive，绝不碰密码；
# 如果 DB 里没有 admin 且 DEFAULT_ADMIN_PASSWORD 没给 → 进程非零退出（避免硬编码弱密码兜底）。
echo "[Entrypoint] Ensuring admin user exists with correct role..."
if ! cd /app && node "$SEED_ADMIN_SCRIPT"; then
    echo "[Entrypoint][FATAL] Admin seed failed. This usually means:"
    echo "  1) No pre-packaged DB / no existing admin user in DB, AND"
    echo "  2) DEFAULT_ADMIN_PASSWORD is not set in the environment."
    echo "  Set DEFAULT_ADMIN_PASSWORD and restart."
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
        su-exec nextjs:nodejs node /app/https-server.js &
    fi
fi

# Execute the main container command as nextjs user
exec su-exec nextjs:nodejs "$@"
