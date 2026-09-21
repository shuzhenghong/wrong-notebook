"""API v1 总路由 — 汇总各子模块 router."""

from __future__ import annotations

from fastapi import APIRouter

from .auth import router as auth_router
from .error_items import router as error_items_router
from .notebooks import router as notebooks_router
from .analyze import router as analyze_router
from .tags import router as tags_router
from .practice import router as practice_router
from .stats import router as stats_router
from .admin import router as admin_router


api_router = APIRouter(prefix="/api")

api_router.include_router(auth_router, tags=["auth"])
api_router.include_router(notebooks_router, prefix="/notebooks", tags=["notebooks"])
api_router.include_router(error_items_router, prefix="/error-items", tags=["error-items"])
api_router.include_router(analyze_router, prefix="/analyze", tags=["analyze"])
api_router.include_router(tags_router, prefix="/tags", tags=["tags"])
api_router.include_router(practice_router, prefix="/practice", tags=["practice"])
api_router.include_router(stats_router, prefix="/stats", tags=["stats"])
api_router.include_router(admin_router, prefix="/admin", tags=["admin"])


@api_router.get("/health", tags=["health"])
def health() -> dict[str, str]:
    """健康检查."""
    return {"status": "ok"}
