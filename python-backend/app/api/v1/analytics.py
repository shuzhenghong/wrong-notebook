"""Analytics + Settings + Import/Export 路由 (Next.js 补全)."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, Subject, User
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger
from ...utils.timeutil import utc_now


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

    # Subject 分布 (把 name 也加进 group by, 满足严格 SQL 语义)
    subject_rows = (
        db.query(Subject.name, func.count(ErrorItem.id))
        .outerjoin(ErrorItem, ErrorItem.subject_id == Subject.id)
        .filter(Subject.user_id == user.id)
        .group_by(Subject.id, Subject.name)
        .all()
    )
    subject_stats = [{"name": name or "Unknown", "value": cnt} for name, cnt in subject_rows]

    # 过去 7 天 activity
    # 原来是循环 7 次各查一遍 (7 条 SQL), 改成一条 GROUP BY 按天聚合
    since = (utc_now() - timedelta(days=6)).replace(hour=0, minute=0, second=0, microsecond=0)
    day_column = func.date(ErrorItem.created_at)
    daily_counts = {
        day: cnt
        for day, cnt in (
            db.query(day_column, func.count(ErrorItem.id))
            .filter(ErrorItem.user_id == user.id, ErrorItem.created_at >= since)
            .group_by(day_column)
            .all()
        )
        if day
    }

    activity_data = []
    for i in range(6, -1, -1):
        d = (utc_now() - timedelta(days=i)).date()
        activity_data.append({
            "date": d.strftime("%m-%d"),
            "count": daily_counts.get(d.strftime("%Y-%m-%d"), 0),
        })

    return {
        "totalErrors": total_errors,
        "masteredCount": mastered_count,
        "masteryRate": mastery_rate,
        "subjectStats": subject_stats,
        "activityData": activity_data,
    }


# =====================================================================
