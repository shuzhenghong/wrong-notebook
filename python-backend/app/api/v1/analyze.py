"""AI 分析路由 — POST /api/analyze + SSE 流式端点.

Token 成本控制（设计说明, 见 config.py 的 "AI 成本控制" 段）:
  1. OCR 文本直通 — 前端本地 OCR 已得到题目文字时, 直接让模型读文字,
     不发送图片. 图片 token 是整个链路里最贵的部分, 直通后归零.
     阈值/开关由 AI_OCR_TEXT_MODE 控制, 默认 auto（>= 80 字才直通）.
  2. 结果缓存 — 相同输入（同一张图/同一段文字 + 同参数）直接复用,
     用户重试、双击、超时重发都不再产生第二次调用.
  3. 条件化 system prompt + 输出限长 — 见 services/ai/prompts.py.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ...config import get_settings
from ...database import get_db
from ...models import KnowledgeTag, Subject, User
from ...schemas.ai import AnalyzedQuestion, AnalyzeResponse
from ...services.ai import get_ai_service
from ...utils import ai_cache
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger
from ...utils.rate_limiter import rate_limit
from ...utils.request_parsing import parse_image_request


router = APIRouter()
logger = get_logger("analyze")

# AI 调用昂贵, 需限流 (每用户每分钟 10 次). 缓存命中不计数.
ANALYZE_RATE_LIMIT = 10
ANALYZE_RATE_WINDOW_SEC = 60


def _check_rate_limit(user_id: str) -> None:
    ok, _remaining, retry_after = rate_limit(
        f"analyze:{user_id}", ANALYZE_RATE_LIMIT, ANALYZE_RATE_WINDOW_SEC
    )
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Analyze rate limit exceeded. Retry after {int(retry_after)}s.",
        )


@dataclass
class AnalyzeInput:
    """一次分析请求的完整输入（已归一化）."""

    image_data_url: str
    subject: str | None
    grade_semester: str | None
    custom_prompt: str | None
    ocr_text: str | None
    text_mode: bool

    def cache_key(self, user_id: str) -> str:
        """缓存键: 用户隔离 + 输入内容 + 影响输出的全部参数."""
        if self.text_mode:
            return ai_cache.make_key(
                user_id, "text", self.ocr_text,
                self.subject, self.grade_semester, self.custom_prompt,
            )
        return ai_cache.make_key(
            user_id, "image", self.image_data_url,
            self.subject, self.grade_semester, self.custom_prompt,
        )


async def _resolve_request(request: Request, db: Session) -> AnalyzeInput:
    """解析请求 → AnalyzeInput.

    同时接受:
      - multipart/form-data: file 字段 "image" + form 字段 (subjectId/subject/ocrText/...)
      - JSON: imageBase64 / imageDataUrl (data URL 或裸 base64)

    subjectId 是笔记本 (Subject) 的 id, 这里解析成学科名供 AI prompt 使用;
    解析失败不阻塞分析 (仅丢失学科上下文)。
    """
    parsed = await parse_image_request(request)
    image_data_url = parsed.image_data_url or ""

    ocr_text = parsed.get("ocrText", "ocr_text")
    if ocr_text:
        ocr_text = ocr_text.strip() or None

    settings = get_settings()
    mode = settings.ai_ocr_text_mode
    text_mode = bool(ocr_text) and (
        mode == "force"
        or (mode == "auto" and len(ocr_text) >= settings.ai_ocr_text_min_chars)
    )
    if ocr_text and mode == "auto" and not text_mode:
        logger.info(
            "OCR text too short for text mode (%d < %d chars), using image",
            len(ocr_text), settings.ai_ocr_text_min_chars,
        )

    # 纯文本模式下没有图片也能分析; 只有走图片模式时才强制要求图片存在
    if not text_mode and not image_data_url.startswith("data:image/"):
        raise HTTPException(
            status_code=400,
            detail=(
                "image is required: multipart file field 'image' "
                "(preferred) or JSON imageBase64/imageDataUrl as data URL"
            ),
        )

    subject_name: str | None = None
    subject_ref = parsed.get("subject", "subjectId", "notebookId")
    if subject_ref:
        s = db.get(Subject, subject_ref)
        # 命中笔记本 → 用它的名字; 没命中说明客户端直接传了学科名
        subject_name = s.name if s is not None else subject_ref

    return AnalyzeInput(
        image_data_url=image_data_url,
        subject=subject_name,
        grade_semester=parsed.get("gradeSemester", "grade_semester"),
        custom_prompt=parsed.get("customPrompt", "custom_prompt"),
        ocr_text=ocr_text if text_mode else None,
        text_mode=text_mode,
    )


def _align_knowledge_tags(question: AnalyzedQuestion, db: Session) -> None:
    """把 AI 给出的知识点标签收敛到库里真实存在的标签.

    学科键容易搞错, 这里特意说明: KnowledgeTag.subject 是 "math"/"physics"
    这类键, 而 Subject 表是用户自建的笔记本（name 形如"数学错题本"）, 二者不能混用.
    AI 自己推断出的 question.subject 恰好就是这套键, 所以用它来过滤.

    库里一条都匹配不上时保留 AI 原始输出 —— 宁可多几个标签,
    也好过因为学科键没对上而把标签整批清空.
    """
    if not question.knowledge_tags or not question.subject:
        return
    matched = (
        db.query(KnowledgeTag)
        .filter(
            KnowledgeTag.subject == question.subject,
            KnowledgeTag.name.in_(question.knowledge_tags),
        )
        .all()
    )
    if matched:
        question.knowledge_tags = [t.name for t in matched]


async def _run_analysis(inp: AnalyzeInput, user: User, db: Session) -> AnalyzedQuestion:
    """缓存 → 限流 → 调模型 → 收敛标签 → 回填缓存.

    缓存命中直接返回, 不消耗限流额度也不产生任何 token 成本.
    """
    key = inp.cache_key(user.id)
    cached = ai_cache.get(key)
    if cached is not None:
        logger.info("analyze cache hit userId=%s text_mode=%s", user.id, inp.text_mode)
        return AnalyzedQuestion(**cached)

    _check_rate_limit(user.id)
    ai = get_ai_service()

    logger.info(
        "Analyzing via %s, subject=%s, text_mode=%s", ai.name, inp.subject, inp.text_mode
    )

    question = await ai.analyze_image(
        image_data_url=inp.image_data_url,
        subject=inp.subject,
        grade_semester=inp.grade_semester,
        custom_prompt=inp.custom_prompt,
        ocr_text=inp.ocr_text,
    )
    _align_knowledge_tags(question, db)
    ai_cache.put(key, question.model_dump())
    return question


# ---------------------------------------------------------------------------
# 同步版 — POST /api/analyze
# ---------------------------------------------------------------------------

@router.post("", response_model=AnalyzeResponse)
async def analyze_image(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AnalyzeResponse:
    inp = await _resolve_request(request, db)
    question = await _run_analysis(inp, user, db)
    return AnalyzeResponse(question=question)


# ---------------------------------------------------------------------------
# SSE 流式版 — POST /api/analyze/stream
# 前端用 lib/stream.ts 的 fetchStream() 消费
# ---------------------------------------------------------------------------

def _sse(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


@router.post("/stream")
async def analyze_image_stream(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """SSE 流式分析 — 先推送 status, 再按段落推送 delta, 最后 done + 完整结果.

    请求体解析同 analyze_image (multipart / JSON 双格式).
    """
    inp = await _resolve_request(request, db)

    async def generator() -> AsyncGenerator[str, None]:
        # 1) 连接已建立
        yield _sse("status", json.dumps({"stage": "connecting"}))
        yield _sse("status", json.dumps({"stage": "analyzing"}))

        # 2) 跑分析（走同一套缓存/限流/标签收敛逻辑）
        try:
            question = await _run_analysis(inp, user, db)
        except HTTPException as e:
            yield _sse("error", json.dumps({"message": str(e.detail)}))
            return
        except Exception as e:  # noqa: BLE001 - 任何失败都要以 SSE 形式告知前端
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
            # 必须用 asyncio.sleep: 在 async generator 里调 time.sleep 会阻塞
            # 整个事件循环, SSE 期间其他所有请求都会被卡死.
            await asyncio.sleep(0.05)

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
