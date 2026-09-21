"""应用配置 — 对应原 Next.js 版的 config.ts + .env.

优先级: 环境变量 > .env 文件 > 默认值
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


BASE_DIR = Path(__file__).resolve().parent.parent


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

    # ---- 图片存储 ----
    upload_dir: str = str(BASE_DIR / "uploads")


@lru_cache
def get_settings() -> Settings:
    """返回单例配置."""
    return Settings()
