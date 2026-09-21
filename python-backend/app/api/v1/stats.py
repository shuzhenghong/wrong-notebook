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
