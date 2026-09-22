"""数据库健康检查 — 供 /health 与 /api/health 共用."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text

from ..database import engine
from .logger import get_logger


logger = get_logger("health")


def probe_db() -> dict[str, Any]:
    """执行一次轻量查询确认数据库可用.

    返回 {"status": ..., "db": ..., "backend": "fastapi"}
    """
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_status = "ok"
    except Exception as exc:  # noqa: BLE001
        logger.error("Health check DB failure: %s", exc)
        db_status = "error"
    return {
        "status": "ok" if db_status == "ok" else "degraded",
        "db": db_status,
        "backend": "fastapi",
    }
