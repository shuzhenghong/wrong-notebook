"""进程内令牌桶限流 — 对应 Next.js 版 rate-limit.ts.

单容器部署足够用; 多实例请换 Redis.
"""

from __future__ import annotations

import time
from collections import OrderedDict


class RateLimiter:
    def __init__(self, max_keys: int = 10000):
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # (tokens, updated_at)
        self._max_keys = max_keys

    def check(self, key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
        """返回 (ok, remaining, retry_after_seconds)."""
        now = time.time()

        if key in self._buckets:
            # LRU touch: 移到末尾
            self._buckets.move_to_end(key)
        else:
            # 超上限 → 先淘汰最旧的 (最靠前的)
            while len(self._buckets) >= self._max_keys:
                self._buckets.popitem(last=False)

        refill_per_sec = limit / window_seconds
        tokens, updated_at = self._buckets.get(key, (float(limit), now))
        elapsed = max(0.0, now - updated_at)
        tokens = min(limit, tokens + elapsed * refill_per_sec)

        if tokens < 1:
            retry_after = (1 - tokens) / refill_per_sec
            self._buckets[key] = (tokens, now)
            return False, 0, retry_after

        tokens -= 1
        self._buckets[key] = (tokens, now)
        return True, int(tokens), 0.0


_limiter = RateLimiter()


def rate_limit(key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
    """模块级快捷入口."""
    return _limiter.check(key, limit, window_seconds)
