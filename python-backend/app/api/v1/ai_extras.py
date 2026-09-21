"""AI 相关额外路由 — reanswer, geogebra-analyze, ai/models, ai/test.

Next.js 原版在 src/app/api/ai/models/, ai/test/, reanswer/, geogebra-analyze/.
Python AI service 目前只有 analyze_image + generate_practice,
所以这些端点暂时返回占位响应 (不影响前端能正常调用).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ...database import get_db
from ...models import User
from ...utils.dependencies import get_current_user


router = APIRouter()


# =====================================================================
# POST /api/reanswer — AI 重新解题
# =====================================================================

@router.post("/reanswer")
async def reanswer(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """AI 重新解题 — 占位实现 (Python AI service 暂未实现 reanswer).

    Next.js 原版: src/app/api/reanswer/route.ts 调 aiService.reanswerQuestion().
    Python AI service 只有 analyze_image + generate_practice,
    所以这里返回一个合理的占位.
    """
    question_text = body.get("questionText", "")
    if not question_text or not question_text.strip():
        raise HTTPException(status_code=400, detail="Missing question text")

    # 尝试用 analyze_image (如果有图片). 否则返回简单模板
    image = body.get("imageBase64")
    if image:
        try:
            from ...services.ai import get_ai_service
            ai = get_ai_service()
            # 把 base64 image 转成 data URL 风格
            if not image.startswith("data:"):
                image = f"data:image/png;base64,{image}"
            result = await ai.analyze_image(image, subject=body.get("subject", "数学"))
            return result
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"AI error: {e}")

    # 纯文本 reanswer — 返回占位
    return {
        "question": question_text,
        "answer": None,  # AI not configured
        "analysis": "AI reanswer requires API keys (not configured).",
        "language": body.get("language", "zh"),
    }


# =====================================================================
# POST /api/geogebra-analyze — AI 分析是否适合 GeoGebra
# =====================================================================

@router.post("/geogebra-analyze")
async def geogebra_analyze(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """GeoGebra 适配分析 — 占位实现."""
    question = body.get("questionText", "")
    if not question.strip():
        return {"suitable": False, "commands": [], "description": "题目文本为空"}

    # 简化启发式判断: 包含几何关键词就认为适合
    geo_keywords = ["三角", "圆", "角", "坐标", "函数图像", "抛物线", "直线", "矩形", "正方形", "点", "线段"]
    suitable = any(kw in question for kw in geo_keywords)

    return {
        "suitable": suitable,
        "commands": [],  # 实际 GeoGebra 命令需要 AI 生成
        "description": "占位实现 — AI GeoGebra integration not configured.",
    }


# =====================================================================
# GET /api/ai/models — 列出可用 AI models
# =====================================================================

@router.get("/ai/models")
def list_ai_models(
    _user: User = Depends(get_current_user),
    provider: str | None = None,
) -> dict:
    """返回 Gemini + OpenAI 可用模型列表 (占位, 不调远端)."""
    all_models = {
        "gemini": [
            {"id": "gemini-2.0-flash-exp", "name": "Gemini 2.0 Flash", "owned_by": "Google"},
            {"id": "gemini-1.5-pro", "name": "Gemini 1.5 Pro", "owned_by": "Google"},
            {"id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash", "owned_by": "Google"},
        ],
        "openai": [
            {"id": "gpt-4o", "name": "GPT-4o", "owned_by": "OpenAI"},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "owned_by": "OpenAI"},
            {"id": "gpt-4-turbo", "name": "GPT-4 Turbo", "owned_by": "OpenAI"},
        ],
    }
    if provider and provider in all_models:
        return {"models": all_models[provider]}
    return {"models": all_models["gemini"] + all_models["openai"]}


# =====================================================================
# POST /api/ai/test — AI 连接测试
# =====================================================================

@router.post("/ai/test")
async def test_ai_connection(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """测试 AI 连接 — 简化实现, 不实际调用 AI."""
    provider = body.get("provider", "unknown")
    return {
        "success": True,
        "message": f"AI {provider} config accepted (placeholder test).",
        "provider": provider,
    }
