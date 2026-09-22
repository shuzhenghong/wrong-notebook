# Python 后端（FastAPI）
#
# 部署拓扑：本服务**只监听容器内网**，不映射到宿主机；
# 浏览器只访问 Next.js 前端（:3000），由前端的 catch-all 路由把 /api/* 转发到这里。
# 这样后端可以安全地开启 TRUST_X_FORWARDED_USER（信任内网注入的用户身份）。
# 若你确实需要把 8000 暴露到公网，请务必设 TRUST_X_FORWARDED_USER=false 并改用 JWT 鉴权。

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 可选：本地 OCR 引擎（rapidocr-onnxruntime + onnxruntime，约 +250MB）
# 默认开启，保证 docker compose 起开箱即用；确要精简镜像时用 --build-arg WITH_OCR=false
ARG WITH_OCR=true

WORKDIR /app

# 依赖单独成层：requirements.txt 不变时可复用缓存，重建极快
COPY requirements.txt ./
COPY requirements-ocr.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_OCR" = "true" ]; then \
           pip install --no-cache-dir -r requirements-ocr.txt; \
       else \
           echo "[dockerfile] WITH_OCR=false, skip local OCR engine"; \
       fi

COPY app ./app
COPY seeds ./seeds

# 数据与上传目录（compose 会挂卷持久化到宿主机）
RUN mkdir -p /app/data/uploads

# 非 root 运行
RUN useradd --system --create-home --uid 1001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# 默认指向持久化目录；compose 会再显式注入一次，
# 这里保证 `docker run` 单容器场景也能直接跑起来
ENV DATABASE_URL="sqlite:////app/data/wrong_notebook.db" \
    UPLOAD_DIR="/app/data/uploads" \
    APP_CONFIG_FILE="/app/data/app-config.json"

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).read()"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
