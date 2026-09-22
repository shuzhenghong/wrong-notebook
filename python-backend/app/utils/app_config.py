"""app-config.json 读写 — 统一入口.

之前 auth.py 用 open("app-config.json") 相对路径 (依赖进程 CWD),
system.py 又用 parents[5] 去猜另一个位置, 两处不一致且都不可靠.
这里统一从 settings.app_config_file 读取, 并加锁避免并发写坏文件.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from ..config import get_settings
from .logger import get_logger


logger = get_logger("app-config")
_lock = threading.Lock()

# 这些字段的值属于机密, 对外返回时必须掩码
_SECRET_KEY_HINTS = ("key", "secret", "token", "password", "endpoint", "baseurl", "apikey")


def config_path() -> Path:
    return Path(get_settings().app_config_file)


def _mask(value: Any) -> Any:
    """把单个值掩码."""
    if isinstance(value, str):
        return "********" if value else value
    return value


def _is_secret_key(key: str) -> bool:
    low = key.lower().replace("_", "").replace("-", "")
    return any(hint in low for hint in _SECRET_KEY_HINTS)


def mask_config(cfg: Any) -> Any:
    """递归掩码: 命中机密关键词的字段值一律替换."""
    if isinstance(cfg, dict):
        return {
            k: (_mask(v) if _is_secret_key(k) else mask_config(v))
            for k, v in cfg.items()
        }
    if isinstance(cfg, list):
        return [mask_config(v) for v in cfg]
    return cfg


def read_config() -> dict[str, Any]:
    """读取配置; 文件不存在/损坏时返回空 dict (不抛异常)."""
    path = config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read %s: %s", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


def read_masked_config() -> dict[str, Any]:
    """读取并掩码后的配置 — 可安全返回给前端."""
    return mask_config(read_config())


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    for k, v in source.items():
        if isinstance(v, dict) and isinstance(target.get(k), dict):
            _deep_merge(target[k], v)
        else:
            target[k] = v
    return target


def write_config(patch: dict[str, Any]) -> dict[str, Any]:
    """合并写入配置, 返回掩码后的结果.

    注意: 调用方传入的机密字段若已是 "********" 会被原样写回,
    因此这里只做合并, 不去猜用户是否想清空.
    """
    path = config_path()
    with _lock:
        current = read_config()
        merged = _deep_merge(current, patch)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(path)  # 原子替换, 避免写一半进程挂掉留下坏文件
    return mask_config(merged)


def allow_registration() -> bool:
    """注册是否开放 — 默认开放."""
    return bool(read_config().get("allowRegistration", True))
