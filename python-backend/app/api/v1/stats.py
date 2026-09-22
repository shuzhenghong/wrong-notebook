"""统计路由 — /api/stats/*."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, Subject, User
from ...utils.dependencies import get_current_user
from ...utils.timeutil import month_keys, utc_now


router = APIRouter()


@router.get("")
def overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    days: int = Query(30, ge=1, le=365),
) -> dict:
    """总览统计 — 原来 6 次独立 count 查询, 合并成 2 次."""
    since = utc_now() - timedelta(days=days)

    # 一次 group by 拿到错题的 总数 / 近期新增 / 已掌握
    item_row = db.query(
        func.count(ErrorItem.id),
        func.sum(case((ErrorItem.created_at >= since, 1), else_=0)),
        func.sum(case((ErrorItem.mastery_level == 2, 1), else_=0)),
    ).filter(ErrorItem.user_id == user.id).first()
    total_items = int(item_row[0] or 0) if item_row else 0
    new_recent = int(item_row[1] or 0) if item_row else 0
    mastered = int(item_row[2] or 0) if item_row else 0

    practice_row = db.query(
        func.count(PracticeRecord.id),
        func.sum(case((PracticeRecord.created_at >= since, 1), else_=0)),
        func.sum(case((PracticeRecord.is_correct.is_(True), 1), else_=0)),
    ).filter(PracticeRecord.user_id == user.id).first()
    practice_total = int(practice_row[0] or 0) if practice_row else 0
    practice_recent = int(practice_row[1] or 0) if practice_row else 0
    practice_correct = int(practice_row[2] or 0) if practice_row else 0

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
    """按错题本统计 — 原来对每个 subject 单独 db.get() 查名字 (N+1).

    改成: 一次取名字表 + 一次 group by 计数, 共 2 条 SQL.
    """
    subjects = {
        s.id: s.name
        for s in db.scalars(select(Subject).where(Subject.user_id == user.id)).all()
    }
    counts = (
        db.query(ErrorItem.subject_id, func.count(ErrorItem.id))
        .filter(ErrorItem.user_id == user.id)
        .group_by(ErrorItem.subject_id)
        .all()
    )

    result: list[dict] = []
    for sid, cnt in counts:
        if not sid:
            result.append({"subject_id": None, "subject_name": "未分类", "count": cnt})
        elif sid in subjects:
            result.append({"subject_id": sid, "subject_name": subjects[sid], "count": cnt})
        else:
            result.append({"subject_id": sid, "subject_name": "(deleted)", "count": cnt})
    result.sort(key=lambda x: x["count"], reverse=True)
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
    # 1. Subject Distribution (SQL 聚合)
    subject_stats = [
        {"name": subj or "Unknown", "value": cnt}
        for subj, cnt in (
            db.query(PracticeRecord.subject, func.count(PracticeRecord.id))
            .filter(PracticeRecord.user_id == user.id)
            .group_by(PracticeRecord.subject)
            .all()
        )
    ]

    # 2. Monthly Activity (Last 6 months)
    #    只取需要的 3 列, 不再把整张表的 ORM 对象全加载进内存
    rows = (
        db.query(
            PracticeRecord.created_at,
            PracticeRecord.is_correct,
            PracticeRecord.difficulty,
        )
        .filter(PracticeRecord.user_id == user.id)
        .all()
    )

    monthly: dict[str, dict] = {k: {"date": k, "total": 0, "correct": 0} for k in month_keys(6)}

    total = 0
    correct = 0
    for created_at, is_correct, difficulty in rows:
        total += 1
        if is_correct:
            correct += 1
        if not created_at:
            continue
        key = created_at.strftime("%Y-%m")
        bucket = monthly.get(key)
        if bucket is None:
            continue
        bucket["total"] += 1
        if is_correct:
            bucket["correct"] += 1
        diff = difficulty or "Unknown"
        bucket[diff] = bucket.get(diff, 0) + 1

    chart_data = sorted(monthly.values(), key=lambda x: x["date"])

    # 3. Difficulty Distribution (SQL 聚合)
    difficulty_stats = [
        {"name": d or "Unknown", "value": cnt}
        for d, cnt in (
            db.query(PracticeRecord.difficulty, func.count(PracticeRecord.id))
            .filter(PracticeRecord.user_id == user.id)
            .group_by(PracticeRecord.difficulty)
            .all()
        )
    ]

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
    return {"message": "Practice history cleared successfully", "count": n}
