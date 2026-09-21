"""AI 服务抽象层 — 工厂模式 (对应 src/lib/ai/index.ts + providers).

支持 Provider: gemini / openai / azure
"""

from .base import AIService
from .factory import get_ai_service

__all__ = ["AIService", "get_ai_service"]
