"""工厂函数 — 根据配置返回 AIService 实例 (对应 getAIService)."""

from __future__ import annotations

import threading

from ...config import get_settings
from ...utils.logger import get_logger
from .base import AIService
from .gemini_provider import make_gemini_service
from .openai_provider import make_azure_service, make_openai_service


logger = get_logger("ai-factory")

# 可失效的单例: 改完 AI 配置后调用 reload_ai_service() 即可重建, 不必重启进程.
_instance: AIService | None = None
_instance_lock = threading.Lock()


def get_ai_service() -> AIService:
    """单例工厂 — 按配置构造 Provider (线程安全, 可经 reload_ai_service 失效)."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = _build()
    return _instance


def reload_ai_service() -> AIService | None:
    """丢弃缓存的 Provider 实例并重建 (管理员改 AI 配置后调用).

    若当前未配置 provider (取不到实例), 不抛异常, 仅把缓存置空,
    下次 get_ai_service() 会重新尝试; 避免 /api/settings 更新因 AI 未配置而 500.
    """
    global _instance
    with _instance_lock:
        try:
            _instance = _build()
        except Exception as exc:  # noqa: BLE001 - 未配置 provider 是常态, 不是错误
            logger.warning("AI provider reload skipped (not configured): %s", exc)
            _instance = None
            return None
    logger.info("AI provider reloaded")
    return _instance


def _build() -> AIService:
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
