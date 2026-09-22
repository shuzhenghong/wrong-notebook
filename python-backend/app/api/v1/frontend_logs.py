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

        if entry.level == "error":
            logger.error(ctx, trimmed)
        elif entry.level == "warn":
            logger.warning(ctx, trimmed)
        else:
            logger.info(ctx, trimmed)
        accepted += 1

    return LogResponse(success=True, count=accepted)
