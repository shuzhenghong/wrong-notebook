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


router = APIRouter(prefix="/analytics")
logger = get_logger("analytics")


# =====================================================================
# GET /api/analytics — 前端 Dashboard 统计
# =====================================================================

@router.get("")
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
