"""工厂函数 — 根据配置返回 AIService 实例 (对应 getAIService)."""

from __future__ import annotations

from functools import lru_cache

from ...config import get_settings
from ...utils.logger import get_logger
from .base import AIService
from .gemini_provider import make_gemini_service
from .openai_provider import make_azure_service, make_openai_service


logger = get_logger("ai-factory")


@lru_cache(maxsize=1)
def get_ai_service() -> AIService:
    """单例工厂 — 按配置构造 Provider."""
    settings = get_settings()
    provider = settings.ai_provider.lower()
    logger.info("Creating AI provider: %s", provider)

    try:
        if provider == "gemini":
            return make_gemini_service()
        if provider == "openai":
            return make_openai_service()
        if provider == "azure":
            return make_azure_service()
    except Exception as exc:  # pragma: no cover - 配置错误
        logger.exception("Failed to create AI provider %s: %s", provider, exc)
        raise

    raise ValueError(f"Unknown ai_provider: {provider}")
