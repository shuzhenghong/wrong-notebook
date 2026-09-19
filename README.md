# Smart Wrong Notebook (智能错题本)

一个基于 AI 的智能错题管理系统，帮助学生高效整理、分析和复习错题。

## ✨ 主要功能

- **🤖 AI 智能分析**：自动识别题目内容，生成解析、知识点标签和同类练习题。
- **⚙️ 灵活的 AI 配置**：支持 **Google Gemini** 和 **OpenAI** (及兼容接口) 两种 AI 提供商，可直接在网页设置中动态切换和配置。
- **📚 多错题本管理**：支持按科目（如数学、物理、英语）创建和管理多个错题本。
- **🏷️ 智能标签系统**：自动提取知识点标签，支持自定义标签管理。
- **🔍 多维度筛选**：支持按掌握状态、时间范围、知识点标签、年级学期、试卷等级等多种条件筛选错题。
- **🖨️ 灵活导出打印**：一键导出筛选后的错题，支持自定义打印内容（答案/解析/知识点）和图片缩放比例，可直接打印或保存为 PDF。
- **📝 智能练习**：基于错题生成相似的练习题，巩固薄弱环节。
- **📊 数据统计**：可视化展示错题掌握情况和学习进度。
- **🔐 用户管理**：支持多用户注册、登录，数据安全隔离。
- **🛡️ 管理员后台**：提供用户管理功能，可禁用/启用用户、删除违规用户。


## 📸 屏幕截图功能 (HTTPS 设置)

本应用的屏幕截图功能依赖浏览器的安全上下文 (HTTPS)。在 Docker 或局域网环境中使用时，请参考 **[HTTPS 配置指南](doc/HTTPS_SETUP.md)** 启用内置 HTTPS 支持。

## 📱 PWA 支持 (添加到主屏幕)

本项目支持 PWA (Progressive Web App)，您可以将应用添加到手机主屏幕，获得原生应用般的使用体验。

**功能特性**：
- 🚀 **快速启动**：点击主屏幕图标直接打开，无需输入网址。
- 📱 **沉浸体验**：全屏运行，无浏览器地址栏干扰。
- 🎨 **原色适配**：应用图标和启动画面适配系统主题。

**使用方法**：

- **iPhone / iPad (Safari)**: 点击底部 **分享** 按钮 -> 选择 **"添加到主屏幕"**。
- **Android (Chrome)**: 点击右上角 **菜单** -> 选择 **"添加到主屏幕"** 或 **"安装应用"**。

## 🛠️ 技术栈

- **框架**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI 库**: [React 19](https://react.dev/)
- **数据库**: [SQLite](https://www.sqlite.org/) (via [Prisma](https://www.prisma.io/))
- **样式**: [Tailwind CSS v4](https://tailwindcss.com/) + [Shadcn UI](https://ui.shadcn.com/)
- **AI**: Google Gemini API / OpenAI API / Azure OpenAI
- **认证**: [NextAuth.js](https://next-auth.js.org/)

## 🚀 快速开始

### 方式一：使用 Docker 部署

#### 1. 启动服务

您可以**零配置**直接启动 —— 只需一条命令，无需预先准备任何环境变量：

- `NEXTAUTH_SECRET`（会话加密密钥）留空时，容器首次启动会**自动生成**并持久化到 `./data/.nextauth_secret`；
- 初始管理员密码留空时，容器首次启动会**自动生成**，并打印在**启动日志**中。

您可以选择 **直接使用命令** (适合快速测试) 或 **Docker Compose** (适合长期运行)。

**选项 A：直接使用 Docker 命令**

```bash
docker run -d --name wrong-notebook \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  ghcr.io/shuzhenghong/wrong-notebook
```

**选项 B：使用 Docker Compose (推荐)**

使用 `docker-compose.yml` 文件进行管理。

1.  **下载配置文件**：
    ```bash
    curl -o docker-compose.yml https://raw.githubusercontent.com/shuzhenghong/wrong-notebook/refs/heads/main/docker-compose.yml
    ```
2.  **启动服务**：
    ```bash
    docker-compose up -d
    ```
3.  **查看初始管理员账号**（首次启动会自动创建并打印）：
    ```bash
    docker-compose logs -f
    ```
    日志中会出现这样的区块：
    ```
    ==================================================================
      首次部署初始化完成 · 管理员账号已创建
    ------------------------------------------------------------------
      登录地址 : http://<服务器IP>:3000
      用户名   : admin@localhost
      密码     : <自动生成的 16 位随机密码>   <<< 请立即记录
    ------------------------------------------------------------------
      * 首次登录后系统会强制要求您修改密码。
      * 该密码只在创建/重置时打印一次，重启容器不会再次显示。
      * 凭据已备份到数据卷：/app/data/initial-admin-credentials.txt
    ==================================================================
    ```
    > 密码**只在创建或重置时打印一次**，同时备份到 `./data/initial-admin-credentials.txt`（权限 600）。
4.  **停止服务**：
    ```bash
    docker-compose down
    ```

#### 2. 忘记管理员密码？

在容器内执行以下命令，会重新生成并打印一个新密码：

```bash
docker-compose exec wrong-notebook node /app/dist-scripts/scripts/seed-admin.js --reset-password
```

### 方式二：本地源码运行

#### 1. 克隆仓库

```bash
git clone https://github.com/shuzhenghong/wrong-notebook.git
cd wrong-notebook
```

#### 2. 环境准备

确保已安装 Node.js (v18+) 和 npm。

#### 3. 安装依赖

```bash
npm install
```

#### 4. 配置环境变量

复制 `.env.example` 为 `.env` 并填入必要的配置：

```bash
cp .env.example .env
```

**基础配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | 数据库连接地址 | `file:./dev.db` | SQLite 数据库路径 |
| `NEXTAUTH_SECRET` | Auth 密钥 | 自动生成 | 用于加密 Session。留空时容器首次启动会**自动生成**强随机密钥并保存到数据卷 `./data/.nextauth_secret`（重启后登录态不失效）；多实例部署请显式设置为固定值，可用 `openssl rand -base64 32` 生成 |
| `NEXTAUTH_URL` | 访问地址 | `http://your-domain-name:3000` | 部署后的访问地址 |
| `DEFAULT_ADMIN_EMAIL` | 初始管理员邮箱 | `admin@localhost` | 仅在管理员账号不存在时生效 |
| `DEFAULT_ADMIN_PASSWORD` | 初始管理员密码 | 自动生成 | 留空时首次启动自动生成强随机密码并**打印在启动日志**中；若自行指定则不回显、不落盘 |
| `AUTH_TRUST_HOST` | 信任主机头 | `true` | 设置为 `true` 时自动推断 URL，适合 Docker/PaaS |
| `LOG_LEVEL` | 日志级别 | `debug` (开发) / `info` (生产) | 可选值：`trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `HTTP_PROXY` | HTTP 代理 | 无 | 设置 HTTP 代理 |
| `HTTPS_PROXY` | HTTPS 代理 | 无 | 设置 HTTPS 代理 |

**AI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `AI_PROVIDER` | AI 提供商 | `gemini` | 可选 `gemini`、`openai` 或 `azure` |

**Gemini 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `GOOGLE_API_KEY` | Gemini API Key | 无 | 使用 Gemini 时必填，从 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| `GEMINI_BASE_URL` | Gemini API 地址 | 无 | 可选，默认 `https://generativelanguage.googleapis.com`，通常无需修改 |
| `GEMINI_MODEL` | Gemini 模型 | `gemini-2.5-flash` | 可选，如 `gemini-2.5-pro`、`gemini-3.0-flash` 等 |

**OpenAI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | OpenAI API Key | 无 | 使用 OpenAI 时必填，从 [OpenAI Platform](https://platform.openai.com/api-keys) 获取 |
| `OPENAI_BASE_URL` | OpenAI API 地址 | 无 | 可选，默认 `https://api.openai.com/v1`；使用第三方兼容服务时填写对应地址 |
| `OPENAI_MODEL` | OpenAI 模型 | `gpt-4o` | 可选，如 `gpt-4-turbo`、`o3`、`o4-mini` 等 |

**Azure OpenAI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `AZURE_OPENAI_API_KEY` | Azure API Key | 无 | 使用 Azure OpenAI 时必填，从 Azure 门户获取 |
| `AZURE_OPENAI_ENDPOINT` | Azure Endpoint | 无 | Azure 资源端点，如 `https://xxx.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | 部署名称 | 无 | Azure 中配置的部署名称，如 `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | API 版本 | `2024-02-15-preview` | 可选，Azure API 版本 |
| `AZURE_OPENAI_MODEL` | Azure 模型 | `gpt-4o` | 可选，显示用的模型名称 |

#### 5. 初始化数据库

```bash
npx prisma migrate dev
npx prisma db seed
```

#### 6. 管理员账户

项目**不内置任何默认密码**，管理员账号在**首次启动时自动初始化**：

- **邮箱**：`admin@localhost`（可用 `DEFAULT_ADMIN_EMAIL` 覆盖）
- **密码**：系统自动生成 16 位强随机密码，并**打印在首次启动日志**中（同时写入 `./data/initial-admin-credentials.txt`，权限 600）

启动日志示例：

```
==================================================================
  首次部署初始化完成 · 管理员账号已创建
------------------------------------------------------------------
  登录地址 : http://<服务器IP>:3000
  用户名   : admin@localhost
  密码     : <自动生成的 16 位随机密码>   <<< 请立即记录
------------------------------------------------------------------
  * 首次登录后系统会强制要求您修改密码。
  * 该密码只在创建/重置时打印一次，重启容器不会再次显示。
  * 凭据已备份到数据卷：/app/data/initial-admin-credentials.txt
==================================================================
```

> - 密码**只在创建或重置时打印一次**；改完密码后建议删除 `initial-admin-credentials.txt`。
> - 由种子创建的管理员**首次登录会被强制要求修改密码**。
> - 管理员登录后，可在"设置" -> "用户管理"中管理系统用户。

**想自己指定初始密码？** 设置环境变量即可（此时密码不回显、不落盘）：

```bash
export DEFAULT_ADMIN_PASSWORD="<一个足够强的密码>"
npx prisma db seed     # 或 Docker 启动时传入 DEFAULT_ADMIN_PASSWORD
```

**忘记密码？** 在容器内执行，会重置并打印一个新密码：

```bash
docker-compose exec wrong-notebook node /app/dist-scripts/scripts/seed-admin.js --reset-password
```

#### 7. 启动开发服务器

```bash
npm run dev
```

访问 [http://your-domain-name:3000](http://your-domain-name:3000) 开始使用。

## ⚙️ AI 模型配置

本项目支持动态配置 AI 模型，无需重启服务器。

1.  **进入设置**：点击首页右上角的设置图标。
2.  **选择提供商**：支持 Google Gemini、OpenAI 和 **Azure OpenAI**。
3.  **填写参数**：
    *   **通用参数**: API Key、Base URL（或 Endpoint）、Model Name（或 Deployment Name）。
    *   **Azure 特有**: Deployment Name（部署名称）、API Version（API 版本）。
4.  **保存生效**：点击保存后即刻生效。

> **注意**：网页配置会保存到 `config/app-config.json` 文件中，该文件的优先级高于 `.env` 环境变量。

### 配置样例

选择提供商后，填写对应参数即可。各服务商获取方式如下：

#### Google Gemini

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | [Google AI Studio](https://aistudio.google.com/apikey) → 创建 API Key |
| Base URL | 默认 `https://generativelanguage.googleapis.com`，通常无需修改 |
| 模型 | `gemini-2.5-flash`（推荐）、`gemini-2.5-pro`、`gemini-3.0-flash` 等 |

#### OpenAI

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | [OpenAI Platform](https://platform.openai.com/api-keys) → Create new secret key |
| Base URL | 默认 `https://api.openai.com/v1` |
| 模型 | `gpt-4o`（推荐）、`gpt-4-turbo`、`o3`、`o4-mini` 等 |

> **兼容模式**：OpenAI 提供商兼容所有支持 OpenAI API 格式的第三方服务。只需将 Base URL 改为对应服务地址，即可使用硅基流动、智谱 GLM、月之暗面 Kimi、通义千问 DashScope 等平台的模型。模型名称需填写对应平台的完整模型 ID。

#### Azure OpenAI

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | Azure 门户 → 你的 OpenAI 资源 → 密钥和终结点 |
| Endpoint | Azure 门户 → 你的 OpenAI 资源 → 终结点，如 `https://xxx.openai.azure.com` |
| 部署名称 | Azure 中配置的模型部署名称，如 `gpt-4o` |
| API 版本 | 默认 `2024-02-15-preview` |
| 模型 | 显示用的模型名称，如 `gpt-4o` |

## 🔤 本地 OCR（离线文字提取）

系统内置**进程内本地 OCR**，开箱即用、无需部署任何额外服务：

- 模型：**PP-OCRv4 中文**（检测 + 方向分类 + 识别，中档精度，随 npm 包分发）
- 推理：`@gutenye/ocr-node` + `onnxruntime-node`，在 Node.js 进程内完成（CPU）
- 拍照/上传裁剪后，裁剪弹窗中除「AI 解析」外多一个**「提取文字」**按钮；
- 提取的文字会自动预填到「手动输入」框，可校对后继续 AI 解题（走文字解析通道，不消耗视觉模型额度）；
- 全程在本机完成，图片不出外网。

**环境变量**：

| 变量 | 说明 | 默认 |
| :--- | :--- | :--- |
| `OCR_BASE_URL` | 可选。设置后改走独立 OCR 服务；留空 = 使用内置引擎 | 空 |
| `OCR_API_KEY` | 独立 OCR 服务启用 `api_key` 时填写 | 空 |
| `OCR_TIMEOUT_MS` | 独立服务单次请求超时（1000~120000） | `20000` |

**可选：独立 OCR 服务**：如果对吞吐有更高要求，可启用 [lw.PPOCR.OpenCVDNN](https://github.com/lxw112190/lw.PPOCR.OpenCVDNN)（OpenCV DNN 纯 CPU C++ 服务）：`docker compose --profile ocr up -d` 并设置 `OCR_BASE_URL=http://ocr:8787`。

> 注意：Dockerfile 已从 alpine 切换到 Debian slim——`onnxruntime-node` 仅提供 glibc 预编译二进制，不支持 musl。本地 OCR 依赖需固定 `onnxruntime-node@1.20.x`（1.30.0 存在 Windows 段错误问题）。

## 🛠️ 实用脚本

在 `scripts/` 目录下提供了一些实用脚本，用于维护和调试：

- **重置密码**:
  ```bash
  node scripts/reset-password.js <邮箱> <新密码>
  ```
  示例:  
  ```bash
  node scripts/reset-password.js user@example.com 123456 
  ```
- **重置管理员密码 / 忘记密码时自助找回**:
  ```bash
  # 自动生成新密码并打印
  docker-compose exec wrong-notebook node /app/dist-scripts/scripts/seed-admin.js --reset-password
  # 或显式指定新密码
  docker-compose exec wrong-notebook node /app/dist-scripts/scripts/seed-admin.js --reset-password --password=<新密码>
  ```

## 💾 数据存储与备份

- **图片存储**：新上传的错题图片会落盘到 `data/images/<userId>/`，数据库只保存访问路径（`/api/images/...`）。历史以 base64 内联存储的图片仍可正常显示，无需迁移。
- **Docker 部署**：数据库与图片都在 `./data` 卷内，备份整个 `data` 目录即可完整恢复。
- **手动备份**：使用设置页的"导出数据"，或在停止写入后复制 `data/dev.db`。
- **系统重置**：管理员执行"系统重置"前会自动在 `data/backups/` 生成一份一致性快照，失败则中止重置。
- **健康检查**：部署后可访问 `/api/health`，返回应用与数据库连通状态（不正常时 HTTP 503）。

## 📄 许可证

MIT License
