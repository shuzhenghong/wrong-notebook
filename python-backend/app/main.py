"""FastAPI 应用入口 — 对应 Next.js 的 app/layout.tsx + 各 route handler."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.v1.router import api_router
from .config import get_settings
from .database import engine, init_db
from .utils.health import probe_db
from .utils.logger import get_logger


logger = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001
    """启动时初始化数据库; 关闭时释放资源."""
    settings = get_settings()
    logger.info("Starting %s v%s (debug=%s)", settings.app_name, settings.app_version, settings.debug)
    init_db()
    logger.info("Database initialized: %s", settings.database_url)
    yield
    logger.info("Shutting down")
    engine.dispose()


def _build_cors_origins(raw: str) -> tuple[list[str], bool]:
    """解析 CORS 源配置.

    浏览器在 `Access-Control-Allow-Origin: *` 时会拒绝携带凭证的请求,
    所以通配符和 credentials=True 不能同时用. 这里显式处理:
    配了 `*` 就自动关掉 credentials, 避免出现"配了却用不了"的诡异行为.
    """
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if not origins:
        return [], False
    if "*" in origins:
        return ["*"], False
    return origins, True


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        description="Python 版智能错题本后端 — FastAPI + SQLAlchemy",
    )

    # CORS
    origins, allow_credentials = _build_cors_origins(settings.cors_origins)
    if settings.cors_allow_credentials is False:
        allow_credentials = False
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---- 统一异常处理 ----
    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        # 422 默认会把整个请求体回显, 可能包含图片 base64 — 只回传字段级错误
        errors = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")}
            for e in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": "Validation error", "errors": errors})

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
        """兜底: 记录完整堆栈, 但只给客户端一个不泄漏内部信息的响应."""
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        detail = str(exc) if settings.debug else "Internal server error"
        return JSONResponse(status_code=500, content={"detail": detail})

    # 路由
    app.include_router(api_router)

    @app.get("/")
    def root() -> dict[str, str]:
        return {
            "name": settings.app_name,
            "version": settings.app_version,
            "docs": "/docs",
            "api": "/api/health",
        }

    @app.get("/health")
    def root_health() -> dict[str, object]:
        """根级健康检查 — 真正连一次数据库."""
        return probe_db()

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1" if settings.debug else "0.0.0.0",
        port=8000,
        reload=settings.debug,
    )
