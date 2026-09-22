"""API v1 总路由 — 汇总各子模块 router."""

from __future__ import annotations

from fastapi import APIRouter

from ...utils.health import probe_db
from .auth import router as auth_router
from .error_items import router as error_items_router
from .notebooks import router as notebooks_router
from .analyze import router as analyze_router
from .tags import router as tags_router
from .practice import router as practice_router
from .stats import router as stats_router
from .admin import router as admin_router
from .system import router as system_router
from .analytics import router as analytics_router
from .ai_extras import router as ai_extras_router
from .import_export import router as import_export_router
from .images import router as images_router
from .ocr import router as ocr_router
from .frontend_logs import router as frontend_logs_router


api_router = APIRouter(prefix="/api")

api_router.include_router(auth_router, tags=["auth"])
api_router.include_router(notebooks_router, prefix="/notebooks", tags=["notebooks"])
api_router.include_router(error_items_router, prefix="/error-items", tags=["error-items"])
api_router.include_router(analyze_router, prefix="/analyze", tags=["analyze"])
api_router.include_router(tags_router, prefix="/tags", tags=["tags"])
api_router.include_router(practice_router, prefix="/practice", tags=["practice"])
api_router.include_router(stats_router, prefix="/stats", tags=["stats"])
api_router.include_router(admin_router, prefix="/admin", tags=["admin"])
api_router.include_router(analytics_router, tags=["analytics"])  # /analytics
api_router.include_router(ai_extras_router, tags=["ai-extras"])
api_router.include_router(import_export_router, tags=["import-export"])
api_router.include_router(system_router)  # /version, /register/status

# === 新迁移的 4 个路由 ===
api_router.include_router(images_router, prefix="/images", tags=["images"])
api_router.include_router(ocr_router, prefix="/ocr", tags=["ocr"])
api_router.include_router(frontend_logs_router, prefix="/logs/frontend", tags=["frontend-logs"])


@api_router.get("/health", tags=["health"])
def health() -> dict[str, object]:
    """健康检查 — 已迁到 Python FastAPI.

    之前 db 字段是硬编码的 "ok", 数据库挂了也报健康,
    负载均衡/容器探针完全失去意义. 现在真的连一次库.
    """
    from datetime import datetime, timezone

    result = probe_db()
    result["timestamp"] = datetime.now(timezone.utc).isoformat()
    return result
