"""已吊销 token 黑名单 — 支持单点登出 / 精确吊销某条 JWT.

jti 作为主键 (uuid4 hex, 唯一). 过期行在写入新记录时顺手清理, 避免无限增长.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from ..utils.timeutil import utc_now
from .base import Base


class TokenBlacklist(Base):
    __tablename__ = "token_blacklist"

    jti: Mapped[str] = mapped_column("jti", String(64), primary_key=True)
    expires_at: Mapped[datetime | None] = mapped_column("expiresAt", DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=utc_now, nullable=False)
