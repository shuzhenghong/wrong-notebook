"""Import/Export + Admin migrate-tags 路由."""

from __future__ import annotations

import json
import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, KnowledgeTag, Subject, User
from ...utils.dependencies import get_current_user, require_admin
from ...utils.logger import get_logger


router = APIRouter(prefix="/import")
logger = get_logger("import")


def _uid() -> str:
    return secrets.token_hex(16)


# =====================================================================
# POST /api/import — 导入错题数据
# =====================================================================

@router.post("")
def import_data(
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """从 Next.js 导出的 JSON 导入数据.

    Next.js 原版: src/app/api/import/route.ts (基于 Prisma upsert).
    Python 版简化: 支持 subjects + error_items, 不支持 customTags.
    """
    version = body.get("version")
    if not version:
        raise HTTPException(status_code=400, detail="Missing version field")

    imported = {"subjects": 0, "errorItems": 0, "tags": 0, "skipped": 0}

    # Subjects
    for s in body.get("subjects", []):
        existing = db.get(Subject, s.get("id")) if s.get("id") else None
        if not existing:
            db.add(Subject(
                id=s.get("id") or _uid(),
                user_id=user.id,
                name=s.get("name", "(imported)"),
            ))
            imported["subjects"] += 1

    # ErrorItems
    for e in body.get("errorItems", []):
        existing = db.get(ErrorItem, e.get("id")) if e.get("id") else None
        if existing:
            imported["skipped"] += 1
            continue
        try:
            db.add(ErrorItem(
                id=e.get("id") or _uid(),
                user_id=user.id,
                subject_id=e.get("subjectId"),
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
        except Exception as ex:
            logger.warning(f"Skipping error item: {ex}")
            imported["skipped"] += 1

    db.commit()
    return {"message": "Import complete", "imported": imported}
