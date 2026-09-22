"""POST /api/logs/frontend — 前端日志上报 + 限流."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...models.user import User
from ...utils.dependencies import get_current_user
from ...utils.logger import get_logger
from ...utils.rate_limiter import rate_limit

logger = get_logger("frontend-logs")

router = APIRouter()

LOG_RATE_LIMIT = 20
LOG_RATE_WINDOW_SEC = 60
MAX_LOG_ENTRIES = 50
MAX_MESSAGE_LENGTH = 2000
MAX_CONTEXT_KEYS = 20

# logging 的保留属性 — 出现在 extra 里会直接把 log() 调用打崩
_RESERVED_LOG_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "asctime", "taskName",
})


def _safe_extra(ctx: dict) -> dict:
    """过滤掉会与 LogRecord 冲突的键, 并统一加前缀避免污染."""
    safe = {}
    for k, v in ctx.items():
        if k in _RESERVED_LOG_ATTRS:
            k = f"ctx_{k}"
        safe[k] = v
    return safe


class LogEntry(BaseModel):
    level: str = Field(default="info", pattern="^(info|warn|error)$")
    prefix: str | None = None
    message: str
    context: dict = Field(default_factory=dict)
    timestamp: str | None = None
    url: str | None = None
    user_agent: str | None = None


class BatchLogRequest(BaseModel):
    logs: list[LogEntry] = Field(default_factory=list)


class LogResponse(BaseModel):
    success: bool
    count: int


@router.post("", response_model=LogResponse)
def post_frontend_log(
    body: BatchLogRequest | LogEntry,
    user: User = Depends(get_current_user),
) -> LogResponse:
    ok, _rem, retry_after = rate_limit(
        f"logs:{user.id}", LOG_RATE_LIMIT, LOG_RATE_WINDOW_SEC
    )
    if not ok:
        raise HTTPException(
            status_code=429,
            detail=f"Too many logs. Retry after {int(retry_after)}s.",
        )

    # 兼容单条或批量
    if isinstance(body, LogEntry):
        raw_logs = [body]
    else:
        raw_logs = body.logs

    if len(raw_logs) > MAX_LOG_ENTRIES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many logs in one batch (max {MAX_LOG_ENTRIES})",
        )

    accepted = 0
    for entry in raw_logs:
        if not entry.message:
            continue

        trimmed = entry.message[:MAX_MESSAGE_LENGTH]
        safe_ctx = {}
        for i, (k, v) in enumerate(entry.context.items()):
            if i >= MAX_CONTEXT_KEYS:
                break
            if isinstance(v, str):
                safe_ctx[k] = v[:200]
            else:
                safe_ctx[k] = v

        ctx = {
            "source": "frontend",
            "userId": user.id,
            "prefix": entry.prefix,
            "url": entry.url,
            "clientTime": entry.timestamp,
            **safe_ctx,
        }

        # 之前写法是 logger.error(ctx, trimmed) —— ctx 被当成 msg 的格式化参数,
        # 结构化字段全部丢失. 正确做法是通过 extra= 传入.
        extra = _safe_extra(ctx)
        if entry.level == "error":
            logger.error(trimmed, extra=extra)
        elif entry.level == "warn":
            logger.warning(trimmed, extra=extra)
        else:
            logger.info(trimmed, extra=extra)
        accepted += 1

    return LogResponse(success=True, count=accepted)
