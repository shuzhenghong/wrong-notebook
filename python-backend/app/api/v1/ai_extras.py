"""AI 相关额外路由 — reanswer, geogebra-analyze, ai/models, ai/test.

reanswer: 有图走 analyze_image (真), 纯文本走 ai.reanswer (真).
ai/test: 真实打一次 provider ping 验证连通性, 不再永远返回假成功.
ai/models: 静态模型目录 (无远端调用, 属正常).
geogebra-analyze: 轻量启发式 (无文本 GeoGebra 生成能力时作为降级).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ...models import User
from ...config import get_settings
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("api:ai-extras")


# =====================================================================
# POST /api/reanswer — AI 重新解题
# =====================================================================

@router.post("/reanswer")
async def reanswer(
    body: dict,
    _user: User = Depends(get_current_user),
) -> dict:
    """AI 重新解题.

    - 有图: 走 analyze_image (真实识别 + 解析).
    - 纯文本: 走 ai.reanswer (真实 LLM 解答).
    - 若 AI 未配置 (取不到 service): 返回 503, 明确告知需要配置, 不再伪造假成功.
    """
    question_text = body.get("questionText", "")
    if not question_text or not question_text.strip():
        raise HTTPException(status_code=400, detail="Missing question text")

    image = body.get("imageBase64")
    if image:
        try:
            from ...services.ai import get_ai_service
            ai = get_ai_service()
            if not image.startswith("data:"):
                image = f"data:image/png;base64,{image}"
            result = await ai.analyze_image(image, subject=body.get("subject", "数学"))
            return result.model_dump() if hasattr(result, "model_dump") else result
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("reanswer AI call failed")
            raise HTTPException(status_code=502, detail="AI service call failed")

    # 纯文本 reanswer — 真实调用 provider
    try:
        from ...services.ai import get_ai_service
        ai = get_ai_service()
    except Exception:  # noqa: BLE001 - 未配置 provider
        raise HTTPException(
            status_code=503,
            detail="AI provider not configured (set ai_provider + api key in .env).",
        )
    try:
        answer = await ai.reanswer(question_text, subject=body.get("subject"))
    except Exception:  # noqa: BLE001
        logger.exception("reanswer AI call failed")
        raise HTTPException(status_code=502, detail="AI service call failed")

    return {
        "question": question_text,
        "answer": answer,
        "analysis": None,
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
    """测试 AI 连接 — 真实打一次 provider ping, 验证 key / endpoint 有效."""
    provider = body.get("provider") or get_settings().ai_provider
    try:
        from ...services.ai import get_ai_service

        ai = get_ai_service()
    except Exception as exc:  # noqa: BLE001 - 未配置 provider
        return {
            "success": False,
            "provider": provider,
            "message": f"AI provider not configured: {exc}",
        }

    try:
        info = await ai.ping()
    except Exception as exc:  # noqa: BLE001 - 连通/鉴权失败
        logger.warning("AI ping failed: %s", exc)
        return {
            "success": False,
            "provider": provider,
            "message": f"AI connection failed: {type(exc).__name__}",
        }

    return {"success": True, "provider": provider, "message": f"AI OK: {info}"}
