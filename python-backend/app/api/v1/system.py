"""version / register/status — Phase 3a 试点迁移的新端点.

Next.js 版这两个 API 不依赖 Prisma, Python 版用 config 文件 + 硬编码版本替代.
"""

from __future__ import annotations

import json

from fastapi import APIRouter

from ...config import BASE_DIR, get_settings
from ...utils.app_config import allow_registration
from ...utils.logger import get_logger


router = APIRouter()
logger = get_logger("api.system")

# 仓库根 = python-backend 的上一级
REPO_ROOT = BASE_DIR.parent


@router.get("/version")
def get_version() -> dict:
    """服务版本号."""
    settings = get_settings()
    pkg_version = "unknown"
    try:
        # 尝试读 Next.js 原版 package.json (仓库根)
        pkg = REPO_ROOT / "package.json"
        if pkg.exists():
            pkg_version = json.loads(pkg.read_text(encoding="utf-8")).get("version", "unknown")
    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("Failed to read package.json: %s", exc)
    return {
        "version": pkg_version,
        "backend": "fastapi",
        "python_version": settings.app_version,
    }


@router.get("/register/status")
def register_status() -> dict:
    """注册是否开放 — 读 app-config.json.

    原实现用 parents[5] 去猜路径 (同一个文件里 /version 用的是 parents[4]),
    索引不一致导致读的根本不是同一个项目目录. 现统一走 app_config 模块.
    """
    return {"allowRegistration": allow_registration()}
