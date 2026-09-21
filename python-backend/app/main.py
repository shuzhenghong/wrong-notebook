"""FastAPI 应用入口 — 对应 Next.js 的 app/layout.tsx + 各 route handler."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.v1.router import api_router
from .config import get_settings
from .database import init_db
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


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        lifespan=lifespan,
        description="Python 版智能错题本后端 — FastAPI + SQLAlchemy",
    )

    # CORS
    origins = [o.strip() for o in settings.cors_origins.split(",")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=get_settings().debug)
