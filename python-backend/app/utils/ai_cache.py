"""AI 分析结果的进程内小型缓存 —— 相同输入不重复烧 token.

为什么需要:
  AI 分析是整个系统里唯一"按次计费"的动作. 用户重试、双击、网络超时后重发、
  同一张图换个笔记本再传, 都会触发一次全新的模型调用. 这些重复请求的输入
  (图片/文字 + 学科 + 参数) 完全一致, 结果也必然一致, 没有任何理由再付费一次.

设计:
  - 键 = sha256(user 隔离 + 输入内容 + 学科 + 年级 + 自定义提示词)
  - 值 = AnalyzedQuestion 的 dict（存 dict 不存模型实例, 避免调用方改到缓存对象）
  - TTL + LRU 容量上限, 单进程内存占用可控
  - 线程安全（uvicorn 线程池里会被并发访问）

不做的事:
  - 不落库、不跨进程共享. 多副本部署时每个副本各自缓存, 命中率下降但语义正确.
    若要跨副本, 把 get/put 换成 Redis 即可, 接口保持不变.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from ..config import get_settings
from .logger import get_logger

logger = get_logger("ai-cache")


@dataclass
class _Entry:
    payload: dict[str, Any]
    expires_at: float


_lock = threading.Lock()
_store: "OrderedDict[str, _Entry]" = OrderedDict()
_hits = 0
_misses = 0


def make_key(*parts: str | bytes | None) -> str:
    """把若干输入片段拼成一个稳定的缓存键（None 与空串区分开）."""
    h = hashlib.sha256()
    for p in parts:
        if p is None:
            h.update(b"\x00")
        elif isinstance(p, bytes):
            h.update(p)
        else:
            h.update(p.encode("utf-8", errors="replace"))
        h.update(b"\x1f")  # 分隔符, 防止 "ab"+"c" 与 "a"+"bc" 撞键
    return h.hexdigest()


def get(key: str) -> dict[str, Any] | None:
    """命中返回 dict 副本; 未命中 / 已过期返回 None."""
    global _hits, _misses
    if not get_settings().ai_cache_enabled:
        return None

    now = time.time()
    with _lock:
        entry = _store.get(key)
        if entry is None:
            _misses += 1
            return None
        if entry.expires_at <= now:
            _store.pop(key, None)
            _misses += 1
            return None
        _store.move_to_end(key)  # LRU: 命中的挪到队尾
        _hits += 1
        return dict(entry.payload)


def put(key: str, payload: dict[str, Any]) -> None:
    """写入缓存, 超容量时淘汰最久未使用的条目."""
    settings = get_settings()
    if not settings.ai_cache_enabled:
        return

    ttl = max(1, settings.ai_cache_ttl_sec)
    max_entries = max(1, settings.ai_cache_max_entries)
    with _lock:
        _store[key] = _Entry(payload=dict(payload), expires_at=time.time() + ttl)
        _store.move_to_end(key)
        while len(_store) > max_entries:
            _store.popitem(last=False)


def stats() -> dict[str, int]:
    """缓存命中情况（供 /api/health 或排查用）."""
    with _lock:
        total = _hits + _misses
        return {
            "hits": _hits,
            "misses": _misses,
            "entries": len(_store),
            "hitRate": round(_hits / total, 3) if total else 0,
        }


def clear() -> None:
    """清空缓存（管理员改 AI 配置后调用, 避免旧 provider 的结果被复用）."""
    with _lock:
        _store.clear()
    logger.info("AI cache cleared")
