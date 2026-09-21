"""AI 分析路由 — POST /api/analyze."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import KnowledgeTag, User
from ...schemas.ai import AnalyzeRequest, AnalyzeResponse
from ...services.ai import get_ai_service
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("analyze")


@router.post("", response_model=AnalyzeResponse)
async def analyze_image(
    payload: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnalyzeResponse:
    """上传图片 (base64 data URL) 让 AI 结构化分析."""
    if not payload.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url must be a data URL")

    ai = get_ai_service()

    # 按学科拿可用标签, 注入 prompt (对应原 prompt 中的 available_tags)
    available_tags: list[str] = []
    if payload.subject:
        available_tags = [
            t.name
            for t in db.query(KnowledgeTag)
            .filter(KnowledgeTag.subject == payload.subject, KnowledgeTag.is_system.is_(True))
            .limit(200)
            .all()
        ]

    logger.info("Analyzing image via %s, subject=%s, tags=%d", ai.name, payload.subject, len(available_tags))

    # 暂时我们在 AIService 接口里没暴露 knowledge_tags 参数 — 简单起见先走无标签版本, 后续可扩展
    question = await ai.analyze_image(
        image_data_url=payload.image_data_url,
        subject=payload.subject,
        grade_semester=payload.grade_semester,
        custom_prompt=payload.custom_prompt,
    )

    # 把知识库标签匹配回系统
    if question.knowledge_tags and payload.subject:
        matched = (
            db.query(KnowledgeTag)
            .filter(
                KnowledgeTag.subject == payload.subject,
                KnowledgeTag.name.in_(question.knowledge_tags),
            )
            .all()
        )
        question.knowledge_tags = [t.name for t in matched]

    return AnalyzeResponse(question=question)
