"""SQLAlchemy 数据库引擎 & Session."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .utils.logger import get_logger


logger = get_logger("database")

settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")

# SQLite 特殊处理
connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    future=True,
    # 连接池预检, 避免使用被数据库侧断开的陈旧连接
    pool_pre_ping=True,
)


if _is_sqlite:
    @event.listens_for(Engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _connection_record):  # noqa: ANN001, ANN202
        """SQLite 默认配置在并发写下会直接抛 'database is locked'.

        开启 WAL 后读写不再互斥, busy_timeout 让写冲突自动等待而不是立刻失败.
        """
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖 — 提供一个请求级 Session.

    注意: 原来的实现异常时只 close() 不 rollback(), 一旦中途抛异常,
    已 flush 的脏数据会留在 session 里, 下一个复用该连接的请求可能读到半成品.
    """
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """初始化数据库表."""
    # 延迟导入避免循环依赖
    from . import models  # noqa: F401  触发模型注册到 Base

    from .models.base import Base

    Base.metadata.create_all(bind=engine)

    # 兼容已存在的旧库: create_all 不会给老表加新列, 这里幂等地补列.
    _migrate_existing_tables(engine)


def _migrate_existing_tables(engine: Engine) -> None:
    """对已存在的表补充新增的列 (SQLite 友好, 可重复执行)."""
    if not _is_sqlite:
        return
    with engine.begin() as conn:
        # User.tokenVersion
        existing = {
            row[1]
            for row in conn.exec_driver_sql("PRAGMA table_info(\"User\")").fetchall()
        }
        if "tokenVersion" not in existing:
            conn.exec_driver_sql(
                'ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0'
            )
            logger.info("Migration: added User.tokenVersion column")
