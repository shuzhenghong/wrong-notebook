"""Analytics + Settings + Import/Export 路由 (Next.js 补全)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...config import get_settings
from ...database import get_db
from ...models import ErrorItem, Subject, User
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("analytics")


# =====================================================================
# GET /api/analytics — 前端 Dashboard 统计
# =====================================================================

@router.get("/analytics")
def analytics_dashboard(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """前端 Dashboard 用的聚合统计 — 原 src/app/api/analytics/route.ts."""
    total_errors = (
        db.scalar(select(func.count()).select_from(ErrorItem).where(ErrorItem.user_id == user.id)) or 0
    )
    mastered_count = (
        db.scalar(
            select(func.count()).select_from(ErrorItem).where(
                ErrorItem.user_id == user.id,
                ErrorItem.mastery_level > 0,
            )
        )
        or 0
    )
    mastery_rate = round(mastered_count / total_errors * 100, 1) if total_errors else 0

    # Subject 分布
    subject_rows = (
        db.query(Subject.name, func.count(ErrorItem.id))
        .outerjoin(ErrorItem, ErrorItem.subject_id == Subject.id)
        .filter(Subject.user_id == user.id)
        .group_by(Subject.id)
        .all()
    )
    subject_stats = [{"name": name or "Unknown", "value": cnt} for name, cnt in subject_rows]

    # 过去 7 天 activity
    activity_data = []
    today = datetime.utcnow().date()
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        day_start = datetime.combine(d, datetime.min.time())
        day_end = datetime.combine(d, datetime.max.time())
        cnt = (
            db.scalar(
                select(func.count()).select_from(ErrorItem).where(
                    ErrorItem.user_id == user.id,
                    ErrorItem.created_at >= day_start,
                    ErrorItem.created_at < day_end,
                )
            )
            or 0
        )
        activity_data.append({"date": d.strftime("%m-%d"), "count": cnt})

    return {
        "totalErrors": total_errors,
        "masteredCount": mastered_count,
        "masteryRate": mastery_rate,
        "subjectStats": subject_stats,
        "activityData": activity_data,
    }


# =====================================================================
# GET/POST /api/settings — 用户配置 (API keys 掩码 + 写入)
# =====================================================================

def _mask_key(k: str | None) -> str | None:
    if not k:
        return k
    return "********"


def _get_app_config() -> dict:
    """返回当前 Next.js app-config.json 的掩码版本."""
    try:
        with open("app-config.json") as f:
            cfg = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        cfg = {}

    # 掩码处理
    def mask(c):
        if isinstance(c, dict):
            return {k: (mask(v) if "key" not in k.lower() and k != "endpoint" else _mask_key(v) if isinstance(v, str) else v) for k, v in c.items()}
        return c

    return mask(cfg)


def _update_app_config(body: dict) -> dict:
    """写回 app-config.json — 简化版 (Next.js 原版有 SSRF 校验, Python 版省略)."""
    try:
        with open("app-config.json") as f:
            current = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        current = {}

    # 深度合并 (简单版)
    def merge(target, source):
        for k, v in source.items():
            if isinstance(v, dict) and isinstance(target.get(k), dict):
                merge(target[k], v)
            else:
                target[k] = v
        return target

    merged = merge(current, body)
    with open("app-config.json", "w") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
    return _get_app_config()


@router.get("/settings")  # 内部, 外部需要挂载到根
def get_settings_endpoint(
    _user: User = Depends(get_current_user),
) -> dict:
    """GET /api/settings — 返回掩码后的配置."""
    return _get_app_config()


@router.post("/settings")
def post_settings_endpoint(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """POST /api/settings — 更新配置 (Python 版省略 SSRF/DNS 校验)."""
    try:
        return _update_app_config(body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
