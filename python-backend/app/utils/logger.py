"""通用日志 (对应原 src/lib/logger.ts)."""

from __future__ import annotations

import logging
import sys

from ..config import get_settings


def get_logger(name: str = "wrong-notebook") -> logging.Logger:
    """返回一个命名 logger, 开发环境彩色, 生产环境 JSON-like."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    settings = get_settings()
    level = logging.DEBUG if settings.debug else logging.INFO
    logger.setLevel(level)

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(level)

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(fmt)
    logger.addHandler(handler)

    logger.propagate = False
    return logger
