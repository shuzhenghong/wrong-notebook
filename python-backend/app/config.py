"""应用配置 — 对应原 Next.js 版的 config.ts + .env.

优先级: 环境变量 > .env 文件 > 默认值
"""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent

# 生产环境必须替换掉的默认密钥
_INSECURE_JWT_SECRET = "change-me-in-production-please-use-a-long-random-string"


class Settings(BaseSettings):
    """全局配置."""

    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- 应用 ----
    app_name: str = "Smart Wrong Notebook (Python)"
    app_version: str = "1.0.0"
    debug: bool = True

    # ---- 数据库 ----
    database_url: str = "sqlite:///./wrong_notebook.db"

    # ---- 认证 ----
    jwt_secret_key: str = "change-me-in-production-please-use-a-long-random-string"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 天

    # ---- AI ----
    ai_provider: Literal["gemini", "openai", "azure"] = "gemini"

    google_api_key: str = ""
    google_model: str = "gemini-1.5-flash"

    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_model: str = "gpt-4o-mini"

    azure_openai_api_key: str = ""
    azure_openai_endpoint: str = ""
    azure_openai_deployment: str = ""

    # ---- CORS ----
    cors_origins: str = "*"
    cors_allow_credentials: bool = True

    # ---- 图片存储 ----
    upload_dir: str = str(BASE_DIR / "uploads")

    # ---- 限流 (多副本部署用 Redis 共享计数) ----
    redis_url: str = ""  # 留空 = 进程内限流 (单容器足够); 配置则走 Redis

    # ---- 应用级配置 (app-config.json) ----
    # 之前代码用相对路径 open("app-config.json"), 依赖进程 CWD, 换个目录启动就失效.
    app_config_file: str = str(BASE_DIR / "app-config.json")

    # ---- 安全 ----
    # 是否信任 Next.js 内网转发的 X-Forwarded-User header (默认否)
    trust_x_forwarded_user: bool = False

    @model_validator(mode="after")
    def _check_production_safety(self) -> "Settings":
        """debug=False (生产) 时拒绝继续用默认 JWT 密钥."""
        if not self.debug and self.jwt_secret_key == _INSECURE_JWT_SECRET:
            raise ValueError(
                "JWT_SECRET_KEY must be set to a random secret when debug=False. "
                "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        return self

    @field_validator("cors_origins")
    @classmethod
    def _normalize_origins(cls, v: str) -> str:
        return v.strip()


@lru_cache
def get_settings() -> Settings:
    """返回单例配置."""
    return Settings()


def reload_settings() -> Settings:
    """清空配置缓存, 重新从环境变量 / .env 读取.

    用于管理员改完 .env 里的 AI key 后, 不必重启整个进程就能让新配置生效
    (配合 services.ai.factory.reload_ai_service 一起用).
    """
    get_settings.cache_clear()
    return get_settings()


def generate_secret_key() -> str:
    """生成一个可用于 JWT_SECRET_KEY 的随机密钥."""
    return secrets.token_urlsafe(48)
