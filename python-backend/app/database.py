"""SQLAlchemy 数据库引擎 & Session."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings


settings = get_settings()

# SQLite 特殊处理
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖 — 提供一个请求级 Session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """初始化数据库表."""
    # 延迟导入避免循环依赖
    from . import models  # noqa: F401  触发模型注册到 Base

    from .models.base import Base

    Base.metadata.create_all(bind=engine)
