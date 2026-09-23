"""练习 / 错题再练 路由 — /api/practice/*."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import ErrorItem, PracticeRecord, User
from ...schemas.ai import MessageResponse, PracticeGenerateRequest, PracticeQuestion
from ...services.ai import get_ai_service
from ...utils.dependencies import get_current_user
from ...utils.ids import new_id
from ...utils.logger import get_logger
from ...utils.rate_limiter import rate_limit


router = APIRouter()
logger = get_logger("practice")

# 生成练习要调大模型, 需限流 (每用户每分钟 15 次)
GENERATE_RATE_LIMIT = 15
GENERATE_RATE_WINDOW_SEC = 60


# ---------- 生成练习 (干扰项) ----------
@router.post("/generate", response_model=PracticeQuestion)
async def generate_practice(
    payload: PracticeGenerateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PracticeQuestion:
    """基于一道错题生成带干扰项的练习小题."""
    ok, _remaining, retry_after = rate_limit(
        f"practice:{user.id}", GENERATE_RATE_LIMIT, GENERATE_RATE_WINDOW_SEC
    )
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Practice rate limit exceeded. Retry after {int(retry_after)}s.",
        )

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

class PracticeRecordCreate(BaseModel):
    """作答记录 — 之前直接用裸 dict, 类型全靠猜且没有归属校验."""

    error_item_id: str | None = None
    subject: str | None = Field(default=None, max_length=64)
    difficulty: str | None = Field(default=None, max_length=16)
    is_correct: bool | None = None

    # 前端统一发 camelCase (isCorrect); 缺 alias_generator 时字段会被静默丢弃,
    # 作答对错永远存不进去, 导致正确率恒为 0.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


@router.post("/record", response_model=MessageResponse)
def record_practice(
    payload: PracticeRecordCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MessageResponse:
    # 防止把练习记录挂到别人的错题上
    if payload.error_item_id:
        item = db.get(ErrorItem, payload.error_item_id)
        if not item or item.user_id != user.id:
            raise HTTPException(status_code=404, detail="ErrorItem not found")

    rec = PracticeRecord(
        id=new_id(),
        user_id=user.id,
        error_item_id=payload.error_item_id,
        subject=payload.subject,
        difficulty=payload.difficulty,
        is_correct=payload.is_correct,
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
