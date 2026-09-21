"""version / register/status — Phase 3a 试点迁移的新端点.

Next.js 版这两个 API 不依赖 Prisma, Python 版用 config 文件 + 硬编码版本替代.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter

from ...config import get_settings
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("api.system")


@router.get("/version")
def get_version() -> dict:
    """服务版本号."""
    settings = get_settings()
    pkg_version = "unknown"
    try:
        # 尝试读 Next.js 原版 package.json
        # app/api/v1/system.py → parents[4] = /workspace (项目根)
        pkg = Path(__file__).resolve().parents[4] / "package.json"
        if pkg.exists():
            pkg_version = json.loads(pkg.read_text()).get("version", "unknown")
    except Exception:
        pass
    return {
        "version": pkg_version,
        "backend": "fastapi",
        "python_version": settings.app_version,
    }


@router.get("/register/status")
def register_status() -> dict:
    """注册是否开放 — 读 app-config.json."""
    # 默认开放 (Next.js 原版 config 默认 allowRegistration !== false)
    allow = True
    try:
        cfg_path = Path(__file__).resolve().parents[5] / "config" / "app-config.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text())
            allow = cfg.get("allowRegistration", True)
    except Exception as exc:
        logger.debug("Failed to read app-config.json: %s", exc)
    return {"allowRegistration": allow}
