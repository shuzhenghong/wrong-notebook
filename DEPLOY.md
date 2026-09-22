# 部署指南（Next.js 前端 + Python FastAPI 后端）

## 架构

```
浏览器 ──► Next.js 前端 :3000 ──► /api/*  (catch-all 代理)
                                      │
                                      ▼
                            FastAPI 后端 :8000  ←── 仅容器内网可见
                                      │
                                      ▼
                          SQLite /app/data/wrong_notebook.db
```

- **前端（Next.js）**：负责 UI、登录会话（NextAuth）、图片/OCR 等少数本地路由；其余 `/api/*` 全部转发给后端。
- **后端（FastAPI）**：错题、笔记本、标签、练习、统计、AI 讲解等业务逻辑与数据，独占数据库。
- 身份桥接：前端解析 NextAuth session → 注入 `X-Forwarded-User` → 后端按 email 自动镜像用户（lazy mirror）。

## 一、Docker Compose 部署（推荐）

### 1. 准备环境变量

```bash
cp .env.example .env
```

编辑 `.env`，**至少确认以下两项**：

| 变量 | 说明 |
|---|---|
| `JWT_SECRET_KEY` | 后端 JWT 密钥，生产必填。生成：`openssl rand -base64 48` |
| `NEXTAUTH_SECRET` | 前端会话密钥，可留空（首次启动自动生成到 `./data/.nextauth_secret`） |

可选的 AI 能力：填 `GOOGLE_API_KEY`（默认 gemini）或 `OPENAI_API_KEY` + `AI_PROVIDER=openai`。留空则 AI 讲解不可用，其余功能正常。

### 2. 启动

**方式 A：本地构建**（代码有改动时用）

```bash
docker compose up -d --build
```

首次构建较慢（前端需 `npm ci` + `next build`，后端需装 Python 依赖）。

**方式 B：直接用 GitHub 构建好的镜像**（推荐，秒级启动）

镜像由 GitHub Actions 自动构建，推送图书写 Git commit sha tag：

| 镜像 | 地址 |
|---|---|
| 前端 | `ghcr.io/shuzhenghong/wrong-notebook:latest` |
| 后端 | `ghcr.io/shuzhenghong/wrong-notebook-backend:latest` |

```bash
# 首次拉取私有镜像需登录（用 GitHub 账号 + Personal Access Token，需 read:packages 权限）
echo $GH_TOKEN | docker login ghcr.io -u <你的GitHub用户名> --password-stdin

# 编辑 docker-compose.yml，把 frontend 服务的 build 段换成 image：
#   image: ghcr.io/shuzhenghong/wrong-notebook:latest
docker compose pull && docker compose up -d
```

> 若镜像为私有导致拉取失败，可在 GitHub 仓库 → Packages → 对应包 → Package settings 中改为 Public；
> 或保持上面的 `docker login` 登录态即可拉取。

### 3. 访问与初始登录

- 打开 <http://localhost:3000>
- 管理员初始密码：若未设 `DEFAULT_ADMIN_PASSWORD`，**首次启动会自动生成强随机密码**，查看方式：

```bash
docker compose logs frontend | grep -i -A3 "initial admin"
cat ./data/initial-admin-credentials.txt
```

### 4. 验证

```bash
# 前端健康检查（会经代理打到后端）
curl http://localhost:3000/api/health
# 期望：{"status":"ok","db":"ok","backend":"fastapi",...}

# 容器状态（backend 应为 healthy）
docker compose ps
```

## 二、本地开发（不用 Docker）

**终端 1 — 后端**

```bash
cd python-backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Windows
# Linux/macOS: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

**终端 2 — 前端**

```bash
npm install
# .env.local 中设置：
#   PYTHON_PROXY_ENABLED=true
#   PYTHON_BACKEND_URL=http://localhost:8000
npm run dev
```

打开 <http://localhost:3000>，接口文档：<http://localhost:8000/docs>

## 三、安全须知（重要）

1. **不要把后端 8000 端口暴露到公网。**
   后端开启了 `TRUST_X_FORWARDED_USER=true`（信任内网注入的身份头）。一旦公网可达，任何人都能伪造该头冒充任意用户。
   若确实需要对外提供 API：把 `TRUST_X_FORWARDED_USER` 设为 `false`，客户端改用 `Authorization: Bearer <jwt>`。

2. `DEBUG=false` 时后端会**拒绝使用默认 JWT 密钥**并拒绝启动——这是刻意的安全保护，请务必设置 `JWT_SECRET_KEY`。

3. `.env` 已在 `.gitignore` 中，不会入库；请勿把密钥提交到仓库。

## 四、数据与备份

所有持久化数据都在 `./data`：

| 路径 | 内容 |
|---|---|
| `./data/dev.db` | 前端 SQLite（NextAuth 用户/会话） |
| `./data/backend/wrong_notebook.db` | 后端 SQLite（错题等业务数据） |
| `./data/backend/uploads` | 上传的图片 |
| `./data/backend/app-config.json` | 应用级配置 |

备份 = 打包 `./data` 目录即可。恢复时原样放回再 `docker compose up -d`。

## 五、排错

| 现象 | 原因与处理 |
|---|---|
| 前端 `/api/*` 全部 404，提示 "Python proxy disabled" | `PYTHON_PROXY_ENABLED` 未设为 `true` |
| 前端 `/api/*` 返回 502 "Proxy error" | 后端未就绪或地址不对；`docker compose logs backend`，确认 `PYTHON_BACKEND_URL=http://backend:8000` |
| 后端启动即退出，报 JWT_SECRET_KEY 相关错误 | 生产模式未设置 `JWT_SECRET_KEY`，见上文 |
| 后端 `unhealthy` | 健康检查走 `/health`（会连一次数据库）；看日志排查 DB 路径权限 |
| 想临时直连后端调试 | `docker compose exec backend python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/health').read())"`；或临时把 `expose` 改成 `ports: - "8000:8000"`（记得同时关闭 `TRUST_X_FORWARDED_USER`） |

## 六、可选：独立 OCR 服务

默认前端使用内置 OCR 引擎，无需额外部署。如需独立 sidecar：

```bash
docker compose --profile ocr up -d
# 并在 .env 中设置 OCR_BASE_URL=http://ocr:8787
```
