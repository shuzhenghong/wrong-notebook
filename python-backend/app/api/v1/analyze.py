"""AI 分析路由 — POST /api/analyze + SSE 流式端点."""

from __future__ import annotations

import json
import time
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import KnowledgeTag, User
from ...schemas.ai import AnalyzeRequest, AnalyzeResponse
from ...services.ai import get_ai_service
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("analyze")


# ---------------------------------------------------------------------------
# 同步版 — POST /api/analyze
# ---------------------------------------------------------------------------

@router.post("", response_model=AnalyzeResponse)
async def analyze_image(
    payload: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnalyzeResponse:
    if not payload.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url must be a data URL")

    ai = get_ai_service()

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

    question = await ai.analyze_image(
        image_data_url=payload.image_data_url,
        subject=payload.subject,
        grade_semester=payload.grade_semester,
        custom_prompt=payload.custom_prompt,
    )

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


# ---------------------------------------------------------------------------
# SSE 流式版 — POST /api/analyze/stream
# 前端用 lib/stream.ts 的 fetchStream() 消费
# ---------------------------------------------------------------------------

def _sse(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


@router.post("/stream")
async def analyze_image_stream(
    payload: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """SSE 流式分析 — 先推送 status, 再按段落推送 delta, 最后 done + 完整结果."""

    if not payload.image_data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="image_data_url must be a data URL")

    async def generator() -> AsyncGenerator[str, None]:
        # 1) 连接已建立
        yield _sse("status", json.dumps({"stage": "connecting"}))

        # 2) 跑 AI (同步拿完整结果)
        ai = get_ai_service()
        yield _sse("status", json.dumps({"stage": "analyzing"}))

        try:
            question = await ai.analyze_image(
                image_data_url=payload.image_data_url,
                subject=payload.subject,
                grade_semester=payload.grade_semester,
                custom_prompt=payload.custom_prompt,
            )
        except Exception as e:
            yield _sse("error", json.dumps({"message": str(e)}))
            return

        # 3) 把 question/answer/analysis 按段落切成 delta 推送
        full_text_parts: list[str] = []
        for label, text in [
            ("题目", question.question_text),
            ("答案", question.answer_text),
            ("解析", question.analysis),
            ("错题分析", question.mistake_analysis),
        ]:
            if text:
                full_text_parts.append(f"## {label}\n\n{text}")

        # 按段落逐段推送 (带小延迟, 让用户看到 "打字机" 效果)
        full_md = "\n\n".join(full_text_parts)
        paragraphs = [p for p in full_md.split("\n\n") if p.strip()]
        for para in paragraphs:
            yield _sse("delta", json.dumps({"text": para + "\n\n"}))
            time.sleep(0.05)  # 50ms 延迟, 够快但有流式感

        # 4) done + 完整 JSON 结构 (给前端存库用)
        yield _sse("status", json.dumps({"stage": "done"}))
        yield _sse("done", json.dumps({
            "question": question.question_text,
            "answer": question.answer_text,
            "analysis": question.analysis,
            "wrongAnswer": question.wrong_answer_text,
            "mistakeAnalysis": question.mistake_analysis,
            "mistakeStatus": question.mistake_status,
            "subject": question.subject,
            "tags": question.knowledge_tags,
        }))

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
