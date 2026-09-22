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

- **前端（Next.js）**：负责 UI 与登录会话（NextAuth）；所有 `/api/*` 一律转发给后端（前端已无本地业务路由，只剩 `[...path]` 代理与 `auth/[...nextauth]`）。
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

**方式 A：直接用 GitHub 构建好的镜像（默认，推荐，秒级启动）**

`docker-compose.yml` 已默认指向 GitHub Actions 自动构建并推送的镜像：

| 镜像 | 地址 |
|---|---|
| 前端 | `ghcr.io/shuzhenghong/wrong-notebook:latest` |
| 后端 | `ghcr.io/shuzhenghong/wrong-notebook-backend:latest` |

```bash
# 首次拉取私有镜像需登录（用 GitHub 账号 + Personal Access Token，需 read:packages 权限）
echo $GH_TOKEN | docker login ghcr.io -u <你的GitHub用户名> --password-stdin

docker compose pull && docker compose up -d
```

> 若镜像为私有导致拉取失败，可在 GitHub 仓库 → Packages → 对应包 → Package settings 中改为 Public；
> 或保持上面的 `docker login` 登录态即可拉取。

**方式 B：本地构建**（代码有改动、或无法访问 GHCR 时用）

```bash
docker compose build && docker compose up -d
```

首次构建较慢（前端需 `npm ci` + `next build`，后端需装 Python 依赖）。

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
   前端 catch-all 代理会把客户端自带的 `X-Forwarded-User` 头**强制剥离**后重新注入服务端解析的身份，因此经前端访问时身份不可伪造；
   但直连 8000 端口仍可任意伪造。若确实需要对外提供 API：把 `TRUST_X_FORWARDED_USER` 设为 `false`，客户端改用 `Authorization: Bearer <jwt>`。

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

## 六、本地 OCR 由后端承担

OCR 跑在 `backend` 内（rapidocr + onnxruntime，PP-OCR 中文模型），前端不再内置引擎，
也不需要 sidecar 容器——compose 里原本的 `ocr` profile 已移除。

- 依赖在 `python-backend/requirements-ocr.txt`，后端镜像**默认安装**
  （Dockerfile 里的 `ARG WITH_OCR=true`）。
- 想做精简镜像：`docker compose build --build-arg WITH_OCR=false backend`。
  关闭后 `POST /api/ocr` 返回 `503 OCR_NOT_INSTALLED`，其余功能不受影响。
- 首次调用会加载模型（约 1~3 秒），之后常驻复用；结果按 sha256 缓存 5 分钟。
- 引擎懒加载 + 缓存都在后端进程内，多副本部署时各副本各自持有，属正常现象。
