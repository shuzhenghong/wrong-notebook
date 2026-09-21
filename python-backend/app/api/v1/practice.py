"""练习 / 错题再练 路由 — /api/practice/*."""

from __future__ import annotations

import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, User
from ...schemas.ai import MessageResponse, PracticeGenerateRequest, PracticeQuestion
from ...services.ai import get_ai_service
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("practice")


def _uid() -> str:
    return secrets.token_hex(16)


# ---------- 生成练习 (干扰项) ----------
@router.post("/generate", response_model=PracticeQuestion)
async def generate_practice(
    payload: PracticeGenerateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PracticeQuestion:
    """基于一道错题生成带干扰项的练习小题."""
    item = (
        db.query(ErrorItem)
        .filter(ErrorItem.id == payload.error_item_id, ErrorItem.user_id == user.id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="ErrorItem not found")
    if not item.question_text:
        raise HTTPException(status_code=400, detail="ErrorItem has no question_text yet")

    subject = item.subject.name if item.subject else None

    ai = get_ai_service()
    logger.info("Generating practice via %s for error_item=%s", ai.name, item.id)

    pq = await ai.generate_practice(
        question_text=item.question_text,
        answer_text=item.answer_text,
        analysis=item.analysis,
        subject=subject,
        option_count=payload.option_count,
    )
    # 把原题塞回 question 字段, 更完整
    pq.question = item.question_text
    return pq


# ---------- 记录一次作答 ----------
class _RecordPayload:
    """简单 dict 协议避免多写一个 schema."""


@router.post("/record", response_model=MessageResponse)
def record_practice(
    payload: dict,  # { error_item_id?, subject?, difficulty?, is_correct? }
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    rec = PracticeRecord(
        id=_uid(),
        user_id=user.id,
        error_item_id=payload.get("error_item_id"),
        subject=payload.get("subject"),
        difficulty=payload.get("difficulty"),
        is_correct=payload.get("is_correct"),
    )
    db.add(rec)
    db.commit()
    return MessageResponse(message="Recorded")


# ---------- 清空练习记录 ----------
@router.delete("/clear", response_model=MessageResponse)
def clear_practice(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    n = db.query(PracticeRecord).filter(PracticeRecord.user_id == user.id).delete()
    db.commit()
    return MessageResponse(message=f"Cleared {n} records")
