"""统计路由 — /api/stats/*."""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, User
from ...utils.dependencies import get_current_user


router = APIRouter()


@router.get("")
def overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    days: int = Query(30, ge=1, le=365),
) -> dict:
    since = datetime.utcnow() - timedelta(days=days)

    total_items = db.scalar(
        select(func.count()).select_from(ErrorItem).where(ErrorItem.user_id == user.id)
    ) or 0
    new_recent = db.scalar(
        select(func.count()).select_from(ErrorItem).where(
            ErrorItem.user_id == user.id, ErrorItem.created_at >= since
        )
    ) or 0
    mastered = db.scalar(
        select(func.count()).select_from(ErrorItem).where(
            ErrorItem.user_id == user.id, ErrorItem.mastery_level == 2
        )
    ) or 0

    practice_total = db.scalar(
        select(func.count()).select_from(PracticeRecord).where(PracticeRecord.user_id == user.id)
    ) or 0
    practice_recent = db.scalar(
        select(func.count()).select_from(PracticeRecord).where(
            PracticeRecord.user_id == user.id, PracticeRecord.created_at >= since
        )
    ) or 0
    practice_correct = db.scalar(
        select(func.count()).select_from(PracticeRecord).where(
            PracticeRecord.user_id == user.id, PracticeRecord.is_correct.is_(True)
        )
    ) or 0

    return {
        "window_days": days,
        "total_error_items": total_items,
        "new_error_items_recent": new_recent,
        "mastered_count": mastered,
        "practice_total": practice_total,
        "practice_recent": practice_recent,
        "practice_correct": practice_correct,
        "practice_accuracy": round(practice_correct / practice_total, 4) if practice_total else 0,
    }


@router.get("/by-mastery")
def by_mastery(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    rows = (
        db.query(ErrorItem.mastery_level, func.count(ErrorItem.id))
        .filter(ErrorItem.user_id == user.id)
        .group_by(ErrorItem.mastery_level)
        .all()
    )
    mapping = {0: "new", 1: "reviewing", 2: "mastered"}
    return [{"mastery_level": level, "label": mapping.get(level, "unknown"), "count": cnt} for level, cnt in rows]


@router.get("/by-subject")
def by_subject(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    from ..v1.notebooks import _uid  # noqa: F401  避免循环导入 lint

    rows = (
        db.query(ErrorItem.subject_id, func.count(ErrorItem.id))
        .filter(ErrorItem.user_id == user.id)
        .group_by(ErrorItem.subject_id)
        .all()
    )
    result: list[dict] = []
    for sid, cnt in rows:
        # 若 sid 为空, 放到 "未分类"
        if not sid:
            result.append({"subject_id": None, "subject_name": "未分类", "count": cnt})
            continue
        from ...models import Subject

        s = db.get(Subject, sid)
        result.append({"subject_id": sid, "subject_name": s.name if s else "(deleted)", "count": cnt})
    return result


# =====================================================================
# Next.js 兼容层 — 保持前端代码零改动
# /api/stats/practice      (Next.js 旧路径, 练习统计 dashboard)
# /api/stats/practice/clear (Next.js 旧路径, 清除练习记录)
# =====================================================================

@router.get("/practice")
def practice_stats_nextjs_compat(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Next.js 前端调用的练习统计 — 与 /api/practice/* 并行存在."""
    from sqlalchemy import and_, or_
    from datetime import date
    from calendar import monthrange

    # 1. Subject Distribution
    rows = (
        db.query(PracticeRecord.subject, func.count(PracticeRecord.id))
        .filter(PracticeRecord.user_id == user.id)
        .group_by(PracticeRecord.subject)
        .all()
    )
    subject_stats = [
        {"name": subj or "Unknown", "value": cnt} for subj, cnt in rows
    ]

    # 2. Monthly Activity (Last 6 months)
    now = datetime.utcnow()
    monthly: dict[str, dict] = {}
    for i in range(5, -1, -1):
        d = now - timedelta(days=30 * i)
        key = d.strftime("%Y-%m")
        monthly[key] = {"date": key, "total": 0, "correct": 0}

    records = (
        db.query(PracticeRecord)
        .filter(PracticeRecord.user_id == user.id)
        .all()
    )
    for rec in records:
        if not rec.created_at:
            continue
        key = rec.created_at.strftime("%Y-%m")
        if key in monthly:
            monthly[key]["total"] += 1
            if rec.is_correct:
                monthly[key]["correct"] += 1
            diff = rec.difficulty or "Unknown"
            monthly[key][diff] = monthly[key].get(diff, 0) + 1

    chart_data = sorted(monthly.values(), key=lambda x: x["date"])

    # 3. Difficulty Distribution
    diff_rows = (
        db.query(PracticeRecord.difficulty, func.count(PracticeRecord.id))
        .filter(PracticeRecord.user_id == user.id)
        .group_by(PracticeRecord.difficulty)
        .all()
    )
    difficulty_stats = [
        {"name": d or "Unknown", "value": cnt} for d, cnt in diff_rows
    ]

    # 4. Overall Correctness
    total = len(records)
    correct = sum(1 for r in records if r.is_correct)
    rate = round(correct / total * 100, 1) if total else 0.0

    return {
        "subjectStats": subject_stats,
        "activityStats": chart_data,
        "difficultyStats": difficulty_stats,
        "overallStats": {"total": total, "correct": correct, "rate": rate},
    }


@router.delete("/practice/clear")
def practice_stats_clear_nextjs_compat(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Next.js 前端调用的练习记录清除 — 委托给 practice.clear 逻辑."""
    n = db.query(PracticeRecord).filter(PracticeRecord.user_id == user.id).delete()
    db.commit()
    return {"message": f"Practice history cleared successfully", "count": n}
