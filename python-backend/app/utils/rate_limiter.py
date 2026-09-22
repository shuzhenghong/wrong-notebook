"""令牌桶限流 — 对应 Next.js 版 rate-limit.ts.

后端可切换:
- 进程内 (默认, 单容器部署足够用)
- Redis (配置了 REDIS_URL 时启用, 多副本部署共享计数, 才能真正限住)

两种后端语义一致 (令牌桶): 窗口内匀速补充令牌, 拿光即限流.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict

from ..config import get_settings
from .logger import get_logger

logger = get_logger("rate-limiter")


class RateLimiter:
    """令牌桶限流接口."""

    def check(self, key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
        """返回 (ok, remaining, retry_after_seconds)."""
        raise NotImplementedError


class InMemoryRateLimiter(RateLimiter):
    """进程内令牌桶.

    FastAPI 的同步 (def) 路由运行在线程池中, 多个请求会并发调用 check(),
    因此这里必须用 Lock 保护 OrderedDict, 否则会触发
    "OrderedDict mutated during iteration" 之类的竞态错误.
    """

    def __init__(self, max_keys: int = 10000):
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # (tokens, updated_at)
        self._max_keys = max_keys
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
        now = time.time()

        with self._lock:
            if key in self._buckets:
                self._buckets.move_to_end(key)  # LRU touch
            else:
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


# Redis 令牌桶: 用 Lua 脚本在单线程里原子地完成 "补充 + 扣减",
# 逻辑与 InMemoryRateLimiter 完全对齐, 保证多副本下行为一致.
_REDIS_LUA = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local refill = limit / window

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = limit
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(limit, tokens + elapsed * refill)

local ok = 1
local retry = 0
if tokens < 1 then
  ok = 0
  retry = (1 - tokens) / refill
else
  tokens = tokens - 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, math.ceil(window) + 1)
return {ok, tokens, retry}
"""


class RedisRateLimiter(RateLimiter):
    """基于 Redis 的令牌桶 (多副本共享计数).

    redis 包未安装或连接失败时会自动回退到进程内实现, 不会让整个接口挂掉.
    """

    def __init__(self, redis_url: str, fallback: RateLimiter):
        import redis  # 延迟导入, 没装 redis 包也不影响其他功能

        self._client = redis.from_url(redis_url, decode_responses=False)
        self._script = self._client.register_script(_REDIS_LUA)
        self._fallback = fallback
        self._healthy = True

    def check(self, key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
        if not self._healthy:
            return self._fallback.check(key, limit, window_seconds)
        try:
            name = f"ratelimit:{key}"
            res = self._script(keys=[name], args=[limit, window_seconds, time.time()])
            ok, tokens, retry = res
            return bool(ok), int(tokens), float(retry)
        except Exception:  # noqa: BLE001 - Redis 抖动时降级, 不让接口 500
            logger.warning("Redis rate limiter unavailable, falling back to in-memory")
            self._healthy = False
            return self._fallback.check(key, limit, window_seconds)


def _build_limiter() -> RateLimiter:
    in_memory = InMemoryRateLimiter()
    redis_url = get_settings().redis_url.strip()
    if not redis_url:
        return in_memory
    try:
        return RedisRateLimiter(redis_url, fallback=in_memory)
    except Exception:  # noqa: BLE001
        logger.warning("REDIS_URL 配置但初始化失败, 使用进程内限流")
        return in_memory


_limiter = _build_limiter()


def rate_limit(key: str, limit: int, window_seconds: float) -> tuple[bool, int, float]:
    """模块级快捷入口."""
    return _limiter.check(key, limit, window_seconds)


def reload_rate_limiter() -> None:
    """配置变更后重建限流器 (切换 Redis / 进程内)."""
    global _limiter
    _limiter = _build_limiter()
