"""Import / Export 路由 — POST /api/import, GET /api/export."""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, selectinload

from ...database import get_db
from ...models import ErrorItem, KnowledgeTag, Subject, User
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger
from ...utils.timeutil import utc_now


router = APIRouter()
logger = get_logger("import-export")


def _uid() -> str:
    return secrets.token_hex(16)


# =====================================================================
# POST /api/import — 导入错题数据
# =====================================================================

@router.post("/import")
def import_data(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """从 Next.js 导出的 JSON 导入数据.

    Next.js 原版: src/app/api/import/route.ts (基于 Prisma upsert).
    """
    version = body.get("version")
    if not version:
        raise HTTPException(status_code=400, detail="Missing version field")

    imported = {"subjects": 0, "errorItems": 0, "tags": 0, "skipped": 0}

    # Subjects — 只认属于当前用户的, 否则可以用别人的 id 覆盖数据
    for s in body.get("subjects", []) or []:
        sid = s.get("id")
        if sid:
            existing = db.get(Subject, sid)
            if existing:
                if existing.user_id != user.id:
                    imported["skipped"] += 1
                    continue
                imported["skipped"] += 1
                continue
        db.add(Subject(
            id=sid or _uid(),
            user_id=user.id,
            name=s.get("name", "(imported)"),
        ))
        imported["subjects"] += 1

    # 提交一次, 让后面 ErrorItem 的 subjectId 外键可用
    db.flush()

    # 校验 subject 归属
    owned_subject_ids = {
        s.id for s in db.query(Subject.id).filter(Subject.user_id == user.id).all()
    }

    # ErrorItems
    for e in body.get("errorItems", []) or []:
        eid = e.get("id")
        if eid and db.get(ErrorItem, eid):
            imported["skipped"] += 1
            continue
        subject_id = e.get("subjectId")
        if subject_id and subject_id not in owned_subject_ids:
            logger.warning("Skipping error item with foreign subjectId=%s", subject_id)
            imported["skipped"] += 1
            continue
        try:
            db.add(ErrorItem(
                id=eid or _uid(),
                user_id=user.id,
                subject_id=subject_id,
                question_text=e.get("questionText") or e.get("ocrText"),
                answer_text=e.get("answerText"),
                analysis=e.get("analysis"),
                mastery_level=e.get("masteryLevel", 0),
                source=e.get("source"),
                error_type=e.get("errorType"),
                user_notes=e.get("userNotes"),
                grade_semester=e.get("gradeSemester"),
            ))
            imported["errorItems"] += 1
        except Exception as ex:  # noqa: BLE001
            logger.warning("Skipping error item: %s", ex)
            imported["skipped"] += 1

    try:
        db.commit()
    except Exception as ex:  # noqa: BLE001
        db.rollback()
        logger.error("Import failed: %s", ex)
        raise HTTPException(status_code=500, detail="Import failed, rolled back")

    return {"message": "Import complete", "imported": imported}


# =====================================================================
# GET /api/export — 导出当前用户的全部数据
# 原模块注释写着 "Import/Export" 但只实现了 Import, 这里补上 Export,
# 否则导进来的数据没法再导出备份 / 迁移.
# =====================================================================

@router.get("/export")
def export_data(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """导出当前用户的错题本 + 错题 + 自定义标签."""
    subjects = (
        db.query(Subject)
        .filter(Subject.user_id == user.id)
        .order_by(Subject.created_at)
        .all()
    )
    items = (
        db.query(ErrorItem)
        .options(selectinload(ErrorItem.tags))
        .filter(ErrorItem.user_id == user.id)
        .order_by(ErrorItem.created_at)
        .all()
    )
    tags = (
        db.query(KnowledgeTag)
        .filter(KnowledgeTag.user_id == user.id, KnowledgeTag.is_system.is_(False))
        .all()
    )

    def iso(dt: datetime | None) -> str | None:
        return dt.isoformat() if dt else None

    return {
        "version": "1.0",
        "exportedAt": iso(utc_now()),
        "subjects": [{"id": s.id, "name": s.name} for s in subjects],
        "customTags": [
            {"id": t.id, "name": t.name, "subject": t.subject} for t in tags
        ],
        "errorItems": [
            {
                "id": i.id,
                "subjectId": i.subject_id,
                "questionText": i.question_text,
                "answerText": i.answer_text,
                "analysis": i.analysis,
                "masteryLevel": i.mastery_level,
                "source": i.source,
                "errorType": i.error_type,
                "userNotes": i.user_notes,
                "gradeSemester": i.grade_semester,
                "createdAt": iso(i.created_at),
                "tagNames": [t.name for t in i.tags],
            }
            for i in items
        ],
    }
